import type { ToolCallDisplay } from '../types/chat'
import { canonicalToolName, normalizeToolInputForCanonical } from '../services/agent/toolNames'

/**
 * Transcript grouping for the chat view. Two cooperating layers:
 *
 * 1. `read_large_result` batching (the original grouper): adjacent paginated
 *    reads of the SAME large_result id consolidate into one row with range
 *    pills (ReadOutputBatch).
 * 2. Exploration grouping (2026-07-10, user request "chat mais limpo"):
 *    adjacent READ-ONLY calls — file reads, searches, globs, directory
 *    listings, output reads, web fetches, guide loads — collapse into a
 *    single sentence row ("A ler 3 ficheiros, a pesquisar 1 padrão…") that
 *    expands to the individual rows on demand (ExplorationBatch).
 *
 * Shared grouping doctrine (what keeps the timeline honest):
 *  - Adjacency only. Assistant text always breaks a group — if the agent
 *    narrated between two reads, that narrative stays between them.
 *  - Reasoning between members is swallowed ONLY when another member
 *    follows (tentative commit) — per-step planning chunks are noise once
 *    the group sentence tells the same story; a trailing thought renders.
 *  - Failures NEVER join a group: a failed call pops out as its own red
 *    row. A green "explored 4 files" hiding one failure would be the worst
 *    possible regression.
 *  - Mutations (writes, shell, deploys) and interactive cards break groups
 *    — they carry decision value and must stay individually visible.
 *  - Sub-agent calls (spawnedBy) never group — they belong to the nested
 *    delegate hierarchy, not the main-agent stream.
 *
 * Pure functions — easy to unit test against arbitrary toolCalls arrays.
 */

export type ToolCallGroup =
  | { kind: 'single'; call: ToolCallDisplay }
  | { kind: 'large_read_batch'; id: string; calls: ToolCallDisplay[] }

const TOOL = 'read_large_result'

function readLargeResultId(tc: ToolCallDisplay): string | null {
  if (tc.toolName !== TOOL) return null
  const id = tc.input?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

// ─── Exploration grouping ────────────────────────────────────────────────

/** Sentence categories, in product language: each maps to a verb phrase in
 *  the group header ("a ler N ficheiros" / "a pesquisar N padrões" / …). */
export type ExplorationCategory = 'files' | 'searches' | 'dirs' | 'outputs' | 'web' | 'guides'

/** Canonical tool → category. Read-only exploration tools ONLY — anything
 *  absent here breaks a group by definition. Deliberately excluded: shell
 *  (exit codes are decision surfaces), writes (approval surfaces), lsp
 *  (rare, unlabelled), task/memory bookkeeping (own treatment later). */
const EXPLORATION_CATEGORIES: Record<string, ExplorationCategory> = {
  read_file: 'files',
  read_around: 'files',
  search_files: 'searches',
  glob: 'searches',
  list_directory: 'dirs',
  read_large_result: 'outputs',
  read_dev_server_logs: 'outputs',
  web_fetch: 'web',
  web_search: 'web',
  read_skill: 'guides',
}

export function explorationCategoryOf(tc: ToolCallDisplay): ExplorationCategory | null {
  return EXPLORATION_CATEGORIES[canonicalToolName(tc.toolName)] ?? null
}

/** Eligibility for membership in an exploration group. Failed calls and
 *  sub-agent children are excluded — see the doctrine at the top. */
export function isExplorationCall(tc: ToolCallDisplay): boolean {
  if (tc.spawnedBy) return false
  if (tc.status === 'failed') return false
  return explorationCategoryOf(tc) !== null
}

/** One user-meaningful exploration ACTION. A streak of paginated reads of
 *  the same large_result id is ONE item (rendered by ReadOutputBatch when
 *  expanded); everything else is one item per call. Items — not raw calls —
 *  drive the group-of-two threshold, so a lone 3-page read keeps its
 *  richer dedicated batch row instead of a vague "explored 1 result". */
export type ExplorationItem =
  | { kind: 'call'; call: ToolCallDisplay }
  | { kind: 'large_read_streak'; id: string; calls: ToolCallDisplay[] }

export function foldExplorationItems(calls: ToolCallDisplay[]): ExplorationItem[] {
  return groupConsecutiveLargeReads(calls).map(group =>
    group.kind === 'single'
      ? { kind: 'call' as const, call: group.call }
      : { kind: 'large_read_streak' as const, id: group.id, calls: group.calls },
  )
}

export interface ExplorationCount {
  category: ExplorationCategory
  count: number
}

function pathOf(call: ToolCallDisplay): string | null {
  const input = normalizeToolInputForCanonical(call.toolName, call.input)
  const raw = input.file_path ?? input.path
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * Per-category counts for the group sentence, in FIRST-OCCURRENCE order so
 * the sentence mirrors what the agent actually did first. Files and folders
 * count DISTINCT paths (re-reads don't inflate "a ler 5 ficheiros" when the
 * agent circled over 2); the other categories count items.
 */
export function explorationCounts(calls: ToolCallDisplay[]): ExplorationCount[] {
  const order: ExplorationCategory[] = []
  const distinctKeys = new Map<ExplorationCategory, Set<string>>()

  const bump = (category: ExplorationCategory, key: string) => {
    let set = distinctKeys.get(category)
    if (!set) {
      set = new Set()
      distinctKeys.set(category, set)
      order.push(category)
    }
    set.add(key)
  }

  for (const item of foldExplorationItems(calls)) {
    if (item.kind === 'large_read_streak') {
      // Streak = one action; keyed by first call id so two separate streaks
      // of the same source (possible across a group after a re-listing)
      // still count individually.
      bump('outputs', item.calls[0].id)
      continue
    }
    const category = explorationCategoryOf(item.call)
    if (!category) continue
    const key = (category === 'files' || category === 'dirs')
      ? (pathOf(item.call) ?? item.call.id)
      : item.call.id
    bump(category, key)
  }

  return order.map(category => ({ category, count: distinctKeys.get(category)!.size }))
}

/** Group threshold: at least two ITEMS. A single action reads better as its
 *  existing dedicated row ("A ler resultado src/foo.ts") than as a vague
 *  group-of-one ("Explorou — 1 ficheiro"). */
function isGroupWorthy(items: ExplorationItem[]): boolean {
  return items.length >= 2
}

/**
 * Per-block render directive for the contentBlocks path. The array returned
 * by `computeContentBlockBatches` is aligned 1:1 with the input blocks
 * (same length, same indices). The caller's existing `.map((block, idx))`
 * loop reads `directives[idx]` first:
 *
 *   - `{ kind: 'render' }` → render the block normally (no grouping applies)
 *   - `{ kind: 'exploration_start', calls }` → render the consolidated
 *     exploration sentence row (ExplorationBatch) at this index
 *   - `{ kind: 'batch_start', calls }` → render the large-read batch row
 *     (ReadOutputBatch) — a run whose ONLY item is one paginated-read streak
 *   - `{ kind: 'batch_member' }` → return null (covered by the start above)
 *
 * The walk collects maximal runs of exploration-eligible tool_call blocks,
 * swallowing reasoning between members (tentative commit: only when another
 * member follows — a trailing thought renders normally; explicit user
 * request from the read_large_result era, now applied to the whole run).
 * The run then downgrades gracefully:
 *   ≥2 items → exploration group;
 *   1 item that is a read streak → the original ReadOutputBatch;
 *   1 plain call → normal row (a group of one is worse than the row).
 *
 * What breaks a run: a `text` block (real assistant prose), any
 * non-exploration tool (writes, shell, cards), a FAILED call (must pop out
 * as its own red row), or a sub-agent child call.
 */
export type ContentBlockDirective =
  | { kind: 'render' }
  | { kind: 'batch_start'; calls: ToolCallDisplay[] }
  | { kind: 'exploration_start'; calls: ToolCallDisplay[] }
  | { kind: 'batch_member' }

/** Block types that can sit between two members without breaking the run.
 *  Currently only `reasoning` — extend with caution; anything carrying
 *  user-visible narrative MUST break the run. */
const SWALLOWABLE_TYPES = new Set(['reasoning'])

export function computeContentBlockBatches(
  blocks: Array<{ type: string; toolCallId?: string }>,
  resolveToolCall: (id: string) => ToolCallDisplay | undefined,
): ContentBlockDirective[] {
  const directives: ContentBlockDirective[] = new Array(blocks.length).fill(null).map(() => ({ kind: 'render' as const }))
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]
    if (block.type !== 'tool_call' || !block.toolCallId) { i += 1; continue }
    const tc = resolveToolCall(block.toolCallId)
    if (!tc || !isExplorationCall(tc)) { i += 1; continue }

    // Greedy look-ahead: collect the maximal run of exploration calls,
    // swallowing reasoning between members (commit only when another
    // member actually follows).
    const memberBlockIdx: number[] = [i]
    const runCalls: ToolCallDisplay[] = [tc]
    const swallowed: number[] = []
    let j = i + 1
    while (j < blocks.length) {
      const nb = blocks[j]
      if (SWALLOWABLE_TYPES.has(nb.type)) {
        let k = j + 1
        while (k < blocks.length && SWALLOWABLE_TYPES.has(blocks[k].type)) k += 1
        if (k >= blocks.length) break
        const candidate = blocks[k]
        if (candidate.type !== 'tool_call' || !candidate.toolCallId) break
        const candidateTc = resolveToolCall(candidate.toolCallId)
        if (!candidateTc || !isExplorationCall(candidateTc)) break
        for (let s = j; s < k; s++) swallowed.push(s)
        memberBlockIdx.push(k)
        runCalls.push(candidateTc)
        j = k + 1
        continue
      }
      if (nb.type !== 'tool_call' || !nb.toolCallId) break
      const ntc = resolveToolCall(nb.toolCallId)
      if (!ntc || !isExplorationCall(ntc)) break
      memberBlockIdx.push(j)
      runCalls.push(ntc)
      j += 1
    }

    const items = foldExplorationItems(runCalls)
    if (isGroupWorthy(items)) {
      directives[i] = { kind: 'exploration_start', calls: runCalls }
      for (const idx of memberBlockIdx) {
        if (idx !== i) directives[idx] = { kind: 'batch_member' }
      }
      for (const s of swallowed) directives[s] = { kind: 'batch_member' }
    } else if (items.length === 1 && items[0].kind === 'large_read_streak') {
      // Single paginated-read streak — keep the dedicated range-pill row.
      // Reasoning swallowed between its pages stays swallowed (the original
      // read_large_result behaviour, preserved by the existing tests).
      directives[i] = { kind: 'batch_start', calls: runCalls }
      for (const idx of memberBlockIdx) {
        if (idx !== i) directives[idx] = { kind: 'batch_member' }
      }
      for (const s of swallowed) directives[s] = { kind: 'batch_member' }
    }
    // else: single plain call — leave every slot as 'render'. Note the
    // tentative-swallow rule guarantees `swallowed` is empty here (a
    // committed swallow implies a second member, and two members can only
    // fold to one item when they are the same read streak).
    i = j
  }
  return directives
}

/** Legacy-path grouping (messages without contentBlocks): same doctrine as
 *  the block walker, over a flat toolCalls array. Shell-session grouping is
 *  the caller's job (it runs first, in MessageBubble); this handles the
 *  ordinary runs between shell groups. */
export type ExplorationRunGroup =
  | ToolCallGroup
  | { kind: 'exploration'; calls: ToolCallDisplay[] }

export function groupExplorationRuns(toolCalls: ToolCallDisplay[]): ExplorationRunGroup[] {
  const groups: ExplorationRunGroup[] = []
  let i = 0
  while (i < toolCalls.length) {
    if (!isExplorationCall(toolCalls[i])) {
      groups.push({ kind: 'single', call: toolCalls[i] })
      i += 1
      continue
    }
    let j = i + 1
    while (j < toolCalls.length && isExplorationCall(toolCalls[j])) j += 1
    const run = toolCalls.slice(i, j)
    const items = foldExplorationItems(run)
    if (isGroupWorthy(items)) {
      groups.push({ kind: 'exploration', calls: run })
    } else {
      // Single item: either one plain call or one read streak — reuse the
      // original grouper so the degenerate cases keep their old rendering.
      groups.push(...groupConsecutiveLargeReads(run))
    }
    i = j
  }
  return groups
}

export function groupConsecutiveLargeReads(toolCalls: ToolCallDisplay[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = []
  let i = 0
  while (i < toolCalls.length) {
    const tc = toolCalls[i]
    const id = readLargeResultId(tc)
    if (id === null) {
      groups.push({ kind: 'single', call: tc })
      i += 1
      continue
    }
    // Greedy extension: while the NEXT call is also read_large_result with
    // the same id, swallow it. A single read_large_result keeps the same
    // shape (calls.length === 1) so the renderer can decide whether to
    // bother with the batch UI for a degenerate batch of one — currently
    // it does, since the batch component still reads cleaner than the
    // generic tool row for paginated reads.
    const batch: ToolCallDisplay[] = [tc]
    let j = i + 1
    while (j < toolCalls.length && readLargeResultId(toolCalls[j]) === id) {
      batch.push(toolCalls[j])
      j += 1
    }
    groups.push({ kind: 'large_read_batch', id, calls: batch })
    i = j
  }
  return groups
}
