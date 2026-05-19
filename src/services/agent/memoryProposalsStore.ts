/**
 * Append-only audit + active-proposals store for memory auto-extraction.
 *
 * Two files coexist in the user/project memory directories:
 *
 *   `_proposed.jsonl` (audit, append-only)
 *     ─ Every proposal the extractor ever produced, one line per
 *       proposal: `{ ts, name, type, description, body, rationale, status }`.
 *       Statuses: `pending` | `saved` | `discarded` | `expired`. Never
 *       overwritten — pure log for debugging extractor quality.
 *
 *   `_proposed-active.json` (live working set)
 *     ─ Up to N most recent `pending` proposals. Injected as a system
 *       reminder on the agent's NEXT turn so the agent decides whether
 *       to convert each into a real save_memory call or let it expire.
 *
 * Lifecycle:
 *   - Extractor fires post-turn → appends to `_proposed.jsonl`, rewrites
 *     `_proposed-active.json` with the new candidates merged in.
 *   - Next turn's prompt build reads `_proposed-active.json` → injects
 *     as system reminder.
 *   - Agent calls `save_memory(...)` → frontend updates `_proposed-active.json`
 *     to drop the saved name (and `_proposed.jsonl` gets a `saved`
 *     entry). Already wired in `save_memory` via the `markProposalSaved`
 *     hook.
 *   - Proposals not acted on after `MAX_PROPOSAL_AGE_MS` get pruned at
 *     load time (silently — the agent already had a chance).
 *
 * Both files live alongside MEMORY.md in the appropriate scope dir.
 * Gitignored via the same `.toquemedia/.gitignore` rule we already write
 * (memory/ entry — wait, memory/ isn't in the gitignore; only sessions/
 * and checkpoints/ are. _proposed files are scope-internal noise though;
 * I'll gitignore them with a prefix-based rule via the writer below).
 */

import { invoke } from '@tauri-apps/api/core'
import type { MemoryProposal } from './memoryExtractor'
import type { MemoryScope } from './memdir'

const PROPOSED_LOG_FILENAME = '_proposed.jsonl'
const PROPOSED_ACTIVE_FILENAME = '_proposed-active.json'

/** Max proposals kept in the active working set at once. Beyond this the
 *  oldest active proposals get pruned to keep the system-reminder
 *  bounded. */
const MAX_ACTIVE_PROPOSALS = 8

/** Active proposals older than this expire silently — the agent had its
 *  shot. Default 30 minutes: long enough to span a few turns, short
 *  enough that stale proposals don't pile up in the reminder. */
const MAX_PROPOSAL_AGE_MS = 30 * 60 * 1000

export type ProposalStatus = 'pending' | 'saved' | 'discarded' | 'expired'

export interface StoredProposal extends MemoryProposal {
  /** Epoch ms when the extractor produced this proposal. */
  ts: number
  /** Lifecycle state. */
  status: ProposalStatus
  /** Scope the proposal targets — extracted from the type via
   *  `defaultScopeForType`, stored explicitly so the agent's
   *  next-turn handler doesn't have to recompute. */
  scope: MemoryScope
}

interface ActiveProposalsFileV1 {
  schemaVersion: 1
  updatedAt: string
  proposals: StoredProposal[]
}

function proposalsBasePath(projectPath: string, scope: MemoryScope, filename: string): string {
  if (scope === 'project') {
    const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
    return `${normalized}/.toquemedia/memory/${filename}`
  }
  // user scope: needs home dir. We compute this in the Rust layer
  // normally, but here we want a direct path for write_file/read_file
  // — same as the rest of the persistence helpers. Caller resolves via
  // `getHomeDir` if needed; for now, project-scope is the common case
  // (most proposals tie to the current task).
  return `~/${filename}` // placeholder — see resolveUserProposalsPath
}

/**
 * Resolve the absolute path for a user-scope proposal file. Same lazy
 * home-dir lookup pattern queueOperationLog uses.
 */
async function resolveUserScopePath(filename: string): Promise<string> {
  const home = await invoke<string>('get_home_directory')
  const normalized = home.replace(/\\/g, '/').replace(/\/$/, '')
  return `${normalized}/.toquemedia-studio/memory/${filename}`
}

async function resolvePath(
  projectPath: string | null,
  scope: MemoryScope,
  filename: string,
): Promise<string> {
  if (scope === 'project') {
    if (!projectPath) throw new Error('project-scope proposals require projectPath')
    return proposalsBasePath(projectPath, 'project', filename)
  }
  return resolveUserScopePath(filename)
}

/**
 * Append a single proposal line to `_proposed.jsonl` (audit). Best-effort.
 */
async function appendProposalLog(
  projectPath: string | null,
  scope: MemoryScope,
  entry: StoredProposal,
): Promise<void> {
  try {
    const path = await resolvePath(projectPath, scope, PROPOSED_LOG_FILENAME)
    await invoke('append_file', {
      path,
      content: JSON.stringify(entry) + '\n',
    })
  } catch { /* swallow — audit is best-effort */ }
}

/**
 * Load the active proposals working set for one scope. Auto-prunes
 * entries older than `MAX_PROPOSAL_AGE_MS` (marked expired in the audit
 * log on the way out) and trims to `MAX_ACTIVE_PROPOSALS` keeping the
 * most recent.
 */
export async function loadActiveProposals(
  projectPath: string | null,
  scope: MemoryScope,
): Promise<StoredProposal[]> {
  try {
    const path = await resolvePath(projectPath, scope, PROPOSED_ACTIVE_FILENAME)
    const raw = await invoke<string>('read_file', { path }).catch(() => null)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<ActiveProposalsFileV1>
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.proposals)) {
      return []
    }
    const now = Date.now()
    const fresh: StoredProposal[] = []
    const expired: StoredProposal[] = []
    for (const p of parsed.proposals) {
      if (!p || typeof p.ts !== 'number') continue
      if (now - p.ts > MAX_PROPOSAL_AGE_MS) {
        expired.push({ ...p, status: 'expired' })
      } else {
        fresh.push(p)
      }
    }
    // Log expirations to the audit and rewrite the active file if we
    // pruned anything — keeps the on-disk state consistent with what we
    // just returned to the caller.
    if (expired.length > 0) {
      for (const e of expired) await appendProposalLog(projectPath, scope, e)
      await writeActiveProposals(projectPath, scope, fresh)
    }
    return fresh.slice(0, MAX_ACTIVE_PROPOSALS)
  } catch {
    return []
  }
}

async function writeActiveProposals(
  projectPath: string | null,
  scope: MemoryScope,
  proposals: StoredProposal[],
): Promise<void> {
  try {
    const path = await resolvePath(projectPath, scope, PROPOSED_ACTIVE_FILENAME)
    if (proposals.length === 0) {
      // Drop the file entirely when empty — keeps the dir clean.
      try { await invoke('delete_file_or_directory', { path }) } catch { /* noop */ }
      return
    }
    const payload: ActiveProposalsFileV1 = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      proposals,
    }
    await invoke('write_file', { path, content: JSON.stringify(payload, null, 2) })
  } catch { /* swallow */ }
}

/**
 * Persist the latest batch of extracted proposals. Merges with the
 * current active set, dedupes by name (newest wins), trims to
 * MAX_ACTIVE_PROPOSALS, appends every accepted proposal to the audit log.
 */
export async function recordProposals(
  projectPath: string | null,
  proposals: MemoryProposal[],
): Promise<void> {
  if (proposals.length === 0) return

  // Split by scope — user vs project routing matches save_memory.
  const { defaultScopeForType } = await import('./memdir')
  const byScope: Record<MemoryScope, StoredProposal[]> = { user: [], project: [] }
  const now = Date.now()
  for (const p of proposals) {
    const scope = defaultScopeForType(p.type)
    byScope[scope].push({ ...p, ts: now, status: 'pending', scope })
  }

  for (const scope of ['user', 'project'] as const) {
    if (byScope[scope].length === 0) continue

    // Project scope requires an open project; if none, those proposals
    // get audit-logged with status: 'discarded' and skipped — the user
    // can re-trigger after opening a project if they care.
    if (scope === 'project' && !projectPath) {
      for (const p of byScope[scope]) {
        await appendProposalLog(null, 'user', { ...p, status: 'discarded' })
      }
      continue
    }

    // Audit every new proposal.
    for (const p of byScope[scope]) {
      await appendProposalLog(projectPath, scope, p)
    }

    // Merge into active set: existing names get replaced by the new
    // version (the extractor may have refined wording); rest is appended.
    const existing = await loadActiveProposals(projectPath, scope)
    const newNames = new Set(byScope[scope].map(p => p.name))
    const merged = [
      ...existing.filter(e => !newNames.has(e.name)),
      ...byScope[scope],
    ].slice(-MAX_ACTIVE_PROPOSALS) // keep most recent
    await writeActiveProposals(projectPath, scope, merged)
  }
}

/**
 * Mark a proposal as saved (the agent converted it into a save_memory
 * call). Removes it from the active set and writes a `saved` audit line.
 * Called from the save_memory tool handler.
 */
export async function markProposalSaved(
  projectPath: string | null,
  name: string,
  type: MemoryProposal['type'],
): Promise<void> {
  const { defaultScopeForType } = await import('./memdir')
  const scope = defaultScopeForType(type)
  const active = await loadActiveProposals(projectPath, scope)
  const remaining: StoredProposal[] = []
  for (const p of active) {
    if (p.name === name) {
      await appendProposalLog(projectPath, scope, { ...p, status: 'saved' })
    } else {
      remaining.push(p)
    }
  }
  if (remaining.length !== active.length) {
    await writeActiveProposals(projectPath, scope, remaining)
  }
}

/**
 * Mark a proposal as explicitly discarded (the agent decided NOT to
 * save it — say the system reminder fired but the agent's judgment
 * says it's not worth keeping). Same effect as markProposalSaved
 * minus the conversion to a real memory.
 */
export async function markProposalDiscarded(
  projectPath: string | null,
  name: string,
  type: MemoryProposal['type'],
): Promise<void> {
  const { defaultScopeForType } = await import('./memdir')
  const scope = defaultScopeForType(type)
  const active = await loadActiveProposals(projectPath, scope)
  const remaining: StoredProposal[] = []
  for (const p of active) {
    if (p.name === name) {
      await appendProposalLog(projectPath, scope, { ...p, status: 'discarded' })
    } else {
      remaining.push(p)
    }
  }
  if (remaining.length !== active.length) {
    await writeActiveProposals(projectPath, scope, remaining)
  }
}

/**
 * Build a system-reminder string the prompt builder injects when there
 * are pending proposals. Returns `null` when both scopes are empty.
 */
export async function buildProposalsReminder(projectPath: string | null): Promise<string | null> {
  const [userProposals, projectProposals] = await Promise.all([
    loadActiveProposals(projectPath, 'user'),
    projectPath
      ? loadActiveProposals(projectPath, 'project')
      : Promise.resolve<StoredProposal[]>([]),
  ])
  const all = [...userProposals, ...projectProposals]
  if (all.length === 0) return null

  const lines: string[] = ['# Pending memory proposals (auto-extracted)']
  lines.push(
    'The extractor reviewed recent turns and identified facts that may be worth persisting. ' +
    'Validate each — if you agree, call `save_memory(name, type, description, body)` to convert. ' +
    'If a proposal is off-target, just ignore it (proposals expire after 30 minutes).',
  )
  lines.push('')
  for (const p of all) {
    lines.push(`- **${p.name}** (${p.type}) — ${p.description}`)
    if (p.rationale) lines.push(`  *Rationale:* ${p.rationale}`)
  }
  return lines.join('\n')
}
