/**
 * Memory distiller — periodic memdir hygiene.
 *
 * Without distillation, every save_memory call adds a row but nothing
 * ever consolidates. Two memories that contradict ("use approach A" +
 * "no, use approach B") sit side-by-side in MEMORY.md and the agent
 * sees both each turn. Memories that turned out wrong are forgotten
 * only when the developer manually says so. Months of use produce
 * stale, noisy memdirs.
 *
 * The distiller reads the FULL memdir (frontmatter + body) and asks the
 * per-plan side-car model to identify three categories:
 *
 *   - **merge**:  two or more entries that say the same thing (or
 *                 incrementally refine each other) — collapse into one.
 *   - **delete**: an entry that's clearly outdated, superseded by a
 *                 newer one, or never applied.
 *   - **rewrite**: an entry whose body is wrong/imprecise but the rule
 *                 it captures still matters — replace its body.
 *
 * The distiller returns PROPOSALS only — it does NOT mutate the memdir.
 * Application happens through the agent's existing `save_memory` /
 * `forget_memory` tools after a human-in-the-loop confirmation (the
 * agent reads the proposals, asks the developer, and acts on approval).
 * That keeps the destructive-action gate where it belongs: with the
 * developer, not in a background batch job.
 *
 * Triggered manually via the `distill_memory` tool. Auto-trigger on
 * project open after >N days is a future addition — not in this cut.
 */

import { logger } from '../../utils/logger'
import { resolveWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService from '../auth/firebaseAuth'
import type { MemoryFile } from './memdir'

/** Per-call timeout — distiller can run longer than the selector
 *  (whole-catalog review with bodies), but still bounded so a stuck
 *  call doesn't hang the agent turn that invoked it. */
const DISTILLER_TIMEOUT_MS = 45_000

/** Cap on combined input bytes — keeps the cost predictable and dodges
 *  the model's context window. ~50KB ≈ ~12K tokens, which Qwen3.6-plus
 *  handles comfortably; larger memdirs get the OLDEST entries dropped
 *  with a warning so the model sees a representative slice. */
const MAX_INPUT_BYTES = 50_000

export interface DistillerProposal {
  /** The action the distiller proposes. */
  action: 'merge' | 'delete' | 'rewrite'
  /** Names of entries this proposal targets. For `merge` and `delete`,
   *  one or more names. For `rewrite`, exactly one. */
  targets: string[]
  /** One-line rationale — what signal the model keyed on. */
  rationale: string
  /** For `merge` and `rewrite`: the proposed body of the consolidated /
   *  replacement entry. The model produces canonical structure
   *  (Lead + Why + How to apply for feedback/project). Empty for
   *  `delete` actions. */
  newBody?: string
  /** For `merge` and `rewrite`: the proposed new name (kebab-case).
   *  For `merge`, this can be one of the merged names OR a fresh one.
   *  For `rewrite`, defaults to the original target name. Empty for
   *  `delete`. */
  newName?: string
  /** For `merge` and `rewrite`: the proposed new description (one line
   *  for MEMORY.md). Empty for `delete`. */
  newDescription?: string
}

export interface DistillerResult {
  proposals: DistillerProposal[]
  inputBytes: number
  /** True iff we had to drop oldest entries to fit MAX_INPUT_BYTES. */
  inputTruncated: boolean
  latencyMs: number
}

interface DistillerInput {
  /** Every memory file the distiller should review (frontmatter parsed). */
  files: MemoryFile[]
}

export async function distillMemories(input: DistillerInput): Promise<DistillerResult | null> {
  const startedAt = performance.now()
  const { files } = input

  if (files.length === 0) {
    return { proposals: [], inputBytes: 0, inputTruncated: false, latencyMs: 0 }
  }

  // Build the catalog block. If we exceed the byte cap, drop oldest
  // entries (no mtime in MemoryFile yet — order by name as a proxy;
  // future enhancement could thread mtime through `loadMemoryFile`).
  let inputBytes = 0
  let inputTruncated = false
  const blocks: string[] = []
  for (const file of files) {
    const fm = file.frontmatter
    if (!fm) continue
    const block = [
      `name: ${fm.name}`,
      `type: ${fm.type}`,
      `description: ${fm.description}`,
      `body:\n${file.body.trim()}`,
      '---',
    ].join('\n')
    if (inputBytes + block.length > MAX_INPUT_BYTES) {
      inputTruncated = true
      break
    }
    blocks.push(block)
    inputBytes += block.length
  }

  if (blocks.length === 0) {
    return { proposals: [], inputBytes: 0, inputTruncated: false, latencyMs: 0 }
  }

  try {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) return null

    const workerUrl = resolveWorkerUrl()
    const ac = new AbortController()
    const timeoutId = setTimeout(() => ac.abort(), DISTILLER_TIMEOUT_MS)

    const distillerSystem = `You review a memory catalog used by a coding agent and propose hygiene actions: merge duplicates, delete stale entries, rewrite imprecise bodies.

Output ONLY a JSON object: {"proposals": [{"action": "merge"|"delete"|"rewrite", "targets": ["..."], "rationale": "...", "newName": "...", "newDescription": "...", "newBody": "..."}]}.

Action rules:
- \`merge\`: two or more entries that say the same thing (verbatim duplicates OR one refines another). Targets ≥ 2 names. \`newName\`/\`newDescription\`/\`newBody\` describe the consolidated entry. Prefer keeping one of the existing names; create a new name only when the merged content covers more ground than any existing label.
- \`delete\`: an entry that's clearly outdated (refers to removed code, superseded by another entry, or rule the developer overrode). Targets = 1 name. \`newName\`/\`newDescription\`/\`newBody\` empty.
- \`rewrite\`: a single entry whose body is wrong, imprecise, or missing the structure (\`feedback\`/\`project\` types must follow Lead + **Why:** + **How to apply:**). Targets = 1 name. \`newName\` defaults to the existing name. Provide \`newDescription\` (≤150 chars) and \`newBody\`.

Be CONSERVATIVE:
- Do NOT propose merging entries that share a topic but say different things — the agent benefits from distinct facts.
- Do NOT propose deleting an entry just because it's old. Age alone isn't a signal; staleness needs a concrete reason.
- When in doubt, leave it alone. Return {"proposals": []} if no action is clearly justified.

The developer will manually approve each proposal before the agent applies it. The agent will call \`save_memory\` for merges/rewrites and \`forget_memory\` for deletes — you don't need to worry about those mechanics.`

    const distillerUser = [
      `## Memory catalog (${blocks.length} entries${inputTruncated ? ', truncated to fit input cap' : ''})`,
      '',
      ...blocks,
      '',
      '## Task',
      'Review the entries above. Propose hygiene actions ONLY where the case is clear-cut. Return {"proposals": []} if everything looks fine.',
    ].join('\n')

    let res: Response
    try {
      res = await fetch(`${workerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
          'X-Request-Type': 'memory-distiller',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: distillerSystem },
            { role: 'user', content: distillerUser },
          ],
          temperature: 0,
          max_tokens: 3500,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!res.ok) {
      logger.warn('memdir', `[distiller] HTTP ${res.status}`)
      return null
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content) return null

    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()

    let parsed: { proposals?: unknown }
    try {
      parsed = JSON.parse(cleaned) as { proposals?: unknown }
    } catch (err) {
      logger.warn('memdir', '[distiller] JSON parse failed:', err)
      return null
    }
    if (!Array.isArray(parsed.proposals)) return null

    const knownNames = new Set(
      files.map(f => f.frontmatter?.name).filter((n): n is string => !!n),
    )

    const proposals: DistillerProposal[] = []
    for (const raw of parsed.proposals) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as Record<string, unknown>
      const action = p.action
      if (action !== 'merge' && action !== 'delete' && action !== 'rewrite') continue
      const targets = Array.isArray(p.targets)
        ? p.targets.filter((t): t is string => typeof t === 'string' && knownNames.has(t))
        : []
      if (targets.length === 0) continue
      if (action === 'merge' && targets.length < 2) continue
      if ((action === 'delete' || action === 'rewrite') && targets.length !== 1) continue
      const rationale = typeof p.rationale === 'string' ? p.rationale.trim() : ''
      if (!rationale) continue

      const proposal: DistillerProposal = { action, targets, rationale }
      if (action !== 'delete') {
        proposal.newName = typeof p.newName === 'string' ? p.newName.trim() : targets[0]
        proposal.newDescription = typeof p.newDescription === 'string' ? p.newDescription.trim() : ''
        proposal.newBody = typeof p.newBody === 'string' ? p.newBody.trim() : ''
        if (!proposal.newDescription || !proposal.newBody) continue
      }
      proposals.push(proposal)
    }

    return {
      proposals,
      inputBytes,
      inputTruncated,
      latencyMs: Math.round(performance.now() - startedAt),
    }
  } catch (err) {
    logger.warn('memdir', '[distiller] failed:', err)
    return null
  }
}
