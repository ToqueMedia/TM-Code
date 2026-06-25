/**
 * Memory auto-extractor — catches memorable facts the agent missed.
 *
 * The save_memory tool depends on the agent NOTICING that a turn produced
 * something worth persisting. In practice the agent does well on explicit
 * corrections ("don't do X") and validated approaches ("yes exactly")
 * but misses subtler signals: a passing detail about the developer's
 * role, an offhand "I prefer Y", a project decision mentioned in the
 * middle of a debugging session. The extractor catches these by reading
 * each turn's user message + assistant reply post-hoc and proposing
 * save_memory calls the agent itself didn't make.
 *
 * Behaviour:
 *   - Fires fire-and-forget AFTER each completed assistant turn.
 *   - Calls the per-plan side-car model (same routing as memory-selector).
 *   - Returns a list of proposals — `name`, `type`, `description`, `body`.
 *   - Proposals are appended to the project memory proposal audit
 *     (audit trail) AND surfaced as a system reminder on the agent's
 *     next turn so the model decides whether to actually save_memory
 *     them or discard.
 *
 * Why proposals (not auto-save):
 *   - Extractor model is small/fast — false positives are likely.
 *   - Auto-saving would silently pollute memdir with noise.
 *   - Giving the agent (with full session context) final approval keeps
 *     the model in control of its own memory.
 *
 * Failure modes ALL fall through silently — the extractor is a nicety,
 * not load-bearing. A broken extractor just means the agent depends on
 * its own discipline (which is the current state without this module).
 */

import { logger } from '../../utils/logger'
import { resolveAIWorkerUrl } from '../../utils/devUrls'
import { resolveAuxByokRoute, byokAuxCompletion } from './byokRouting'
import FirebaseAuthService, { getAppCheckHeader } from '../auth/firebaseAuth'
import type { MemoryType } from './memdir'

/** Per-call timeout — extractor is fire-and-forget, post-turn, so this
 *  shouldn't block anything user-visible. Kept conservative anyway. */
const EXTRACTOR_TIMEOUT_MS = 15_000

/** Cap on proposals per turn — defends against a chatty model returning
 *  half a dozen "memories" from a routine "fix this typo" turn. */
const MAX_PROPOSALS_PER_RUN = 5

/** Minimum user-message length before extraction is attempted. Skips
 *  trivial turns ("ok", "yes", "thanks") where there's nothing to learn. */
const MIN_USER_MESSAGE_LENGTH = 30

export interface MemoryProposal {
  name: string
  type: MemoryType
  description: string
  body: string
  /** One-line rationale from the extractor explaining WHY this is worth
   *  saving — surfaced to the agent so it can validate the proposal's
   *  reasoning before invoking save_memory. */
  rationale: string
}

export interface ExtractorResult {
  proposals: MemoryProposal[]
  latencyMs: number
}

interface ExtractorInput {
  /** The user message that just landed. */
  userMessage: string
  /** Final assistant text from the same turn (last 4000 chars if long). */
  assistantText: string
  /** Existing memory names — the extractor avoids re-proposing duplicates. */
  existingNames: string[]
}

/**
 * Run a single extraction pass over the most recent turn. Returns
 * `proposals: []` for any failure or "nothing memorable" — callers can't
 * distinguish, and don't need to.
 */
export async function extractMemoriesFromTurn(input: ExtractorInput): Promise<ExtractorResult> {
  const { userMessage, assistantText, existingNames } = input
  const startedAt = performance.now()

  // Cheap pre-filter — don't waste a model call on trivial turns.
  if (!userMessage || userMessage.length < MIN_USER_MESSAGE_LENGTH) {
    return { proposals: [], latencyMs: 0 }
  }

  try {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) return { proposals: [], latencyMs: 0 }

    const workerUrl = resolveAIWorkerUrl()
    const ac = new AbortController()
    const timeoutId = setTimeout(() => ac.abort(), EXTRACTOR_TIMEOUT_MS)

    const existingList = existingNames.length > 0
      ? `\n\nMemories already saved (do NOT re-propose these — pick a different name OR skip):\n${existingNames.slice(0, 80).map(n => `- ${n}`).join('\n')}`
      : ''

    const extractorSystem = `You read one conversation turn and propose memories worth persisting across future sessions.

A memory belongs to one of FOUR types (closed taxonomy):
- \`user\`: developer's role, expertise, working style. Helps frame future explanations.
- \`feedback\`: explicit correction ("don't X") OR validated approach ("yes exactly, do X"). Save with **Why:** and **How to apply:** lines.
- \`project\`: ongoing initiative, decision, motivation specific to this project. Captures the *why* behind code.
- \`reference\`: where to look for X in external systems (Linear, Slack, dashboards).

Output ONLY a JSON object: {"proposals": [{"name": "...", "type": "...", "description": "...", "body": "...", "rationale": "..."}]}.

Rules:
- Pick at most ${MAX_PROPOSALS_PER_RUN} proposals.
- Each \`name\` is short kebab-case (e.g. "no-trailing-summaries", "prefers-pnpm").
- Each \`description\` is one line ≤150 chars — what shows up in MEMORY.md.
- For \`feedback\` and \`project\` types, the \`body\` MUST follow:
  Lead with the rule/fact.\n\n**Why:** <the motivation>.\n\n**How to apply:** <when/where this kicks in>.
- For \`user\` and \`reference\` types, plain prose body is fine.
- \`rationale\` is one short sentence explaining WHY this is worth saving (the signal you keyed on).
- Return {"proposals": []} when the turn has nothing memorable. Routine bug-fixes, code reads, and yes/no exchanges produce nothing. Demand a real signal: explicit preference, validated approach, project-context disclosure, external-system pointer.
- DO NOT save code patterns, file paths, debugging recipes, or anything derivable from the code itself.
- DO NOT save ephemeral task state — the task tracker handles that.${existingList}`

    const extractorUser = `## Developer's most recent message
${userMessage.slice(0, 4000)}

## Agent's response (this turn)
${assistantText.slice(-4000)}`

    const messages = [
      { role: 'system', content: extractorSystem },
      { role: 'user', content: extractorUser },
    ]

    // Free + BYOK: extract memory on the user's own key (their cost). Paid+BYOK
    // and non-BYOK keep the TM worker (sidecar) path below.
    const auxRoute = resolveAuxByokRoute()
    let content: string
    if (auxRoute) {
      clearTimeout(timeoutId)
      content = (await byokAuxCompletion(auxRoute.snapshot, {
        messages,
        maxTokens: 1600,
        temperature: 0,
        jsonObject: true,
        signal: ac.signal,
      })) ?? ''
    } else {
      let res: Response
      try {
        const appCheck = await getAppCheckHeader()
        res = await fetch(`${workerUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
            'X-Request-Type': 'memory-extractor',
            ...appCheck,
          },
          body: JSON.stringify({
            messages,
            temperature: 0,
            max_tokens: 1600,
            stream: false,
            response_format: { type: 'json_object' },
          }),
          signal: ac.signal,
        })
      } finally {
        clearTimeout(timeoutId)
      }

      if (!res.ok) {
        logger.debug('memdir', `[extractor] HTTP ${res.status}`)
        return { proposals: [], latencyMs: Math.round(performance.now() - startedAt) }
      }

      const ct = res.headers.get('content-type') ?? 'unknown'
      const rawBody = await res.text().catch(() => '')
      let data: { choices?: Array<{ message?: { content?: string } }> }
      try {
        data = JSON.parse(rawBody) as { choices?: Array<{ message?: { content?: string } }> }
      } catch (jsonErr) {
        // Worker may return non-JSON (HTML error page, empty body, etc.)
        // on auth failures or upstream issues. Log status + content-type
        // for debugging but swallow gracefully — extractor is fire-and-forget.
        const preview = rawBody.slice(0, 200).replace(/\s+/g, ' ')
        logger.debug('memdir', `[extractor] response is not valid JSON (HTTP ${res.status}, content-type: ${ct}, body="${preview}"):`, jsonErr)
        return { proposals: [], latencyMs: Math.round(performance.now() - startedAt) }
      }
      content = data.choices?.[0]?.message?.content ?? ''
    }
    if (!content) {
      return { proposals: [], latencyMs: Math.round(performance.now() - startedAt) }
    }

    // Tolerant parse — strip code fences if present.
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()

    let parsed: { proposals?: unknown }
    try {
      parsed = JSON.parse(cleaned) as { proposals?: unknown }
    } catch {
      return { proposals: [], latencyMs: Math.round(performance.now() - startedAt) }
    }

    if (!Array.isArray(parsed.proposals)) {
      return { proposals: [], latencyMs: Math.round(performance.now() - startedAt) }
    }

    const validTypes: ReadonlySet<MemoryType> = new Set([
      'user', 'feedback', 'project', 'reference',
    ] as const)
    const existingSet = new Set(existingNames)

    const proposals: MemoryProposal[] = []
    for (const raw of parsed.proposals) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as Record<string, unknown>
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      const type = typeof p.type === 'string' ? p.type.trim() as MemoryType : '' as MemoryType
      const description = typeof p.description === 'string' ? p.description.trim() : ''
      const body = typeof p.body === 'string' ? p.body.trim() : ''
      const rationale = typeof p.rationale === 'string' ? p.rationale.trim() : ''
      if (!name || !validTypes.has(type) || !description || !body) continue
      if (description.length > 200) continue
      if (existingSet.has(name)) continue // model ignored the "don't re-propose" rule
      proposals.push({ name, type, description, body, rationale })
      if (proposals.length >= MAX_PROPOSALS_PER_RUN) break
    }

    return { proposals, latencyMs: Math.round(performance.now() - startedAt) }
  } catch (err) {
    logger.debug('memdir', '[extractor] failed:', err)
    return { proposals: [], latencyMs: Math.round(performance.now() - startedAt) }
  }
}
