import type { ToolCallDisplay } from '../types/chat'

/**
 * Group adjacent `read_large_result` tool calls that target the SAME
 * large_result id into a single "batch" entry, leaving every other tool
 * call as a `single` entry. Used by MessageBubble to render consecutive
 * paginated reads as one consolidated row instead of a tall stack.
 *
 * Why "adjacent only": if the agent reads slice A, runs `grep`, then reads
 * slice B from the same id, the grep result MUST remain visually between
 * the two reads — otherwise the narrative of "looked, searched, looked
 * again" gets lost. Adjacency keeps the timeline honest.
 *
 * Why "same id only": different large_result ids represent different
 * sources (a search result vs a file dump). Mixing them in one batch row
 * would erase that distinction.
 *
 * Pure function — easy to unit test against arbitrary toolCalls arrays.
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

/**
 * Per-block render directive for the contentBlocks path. The array returned
 * by `computeContentBlockBatches` is aligned 1:1 with the input blocks
 * (same length, same indices). The caller's existing `.map((block, idx))`
 * loop reads `directives[idx]` first:
 *
 *   - `{ kind: 'render' }` → render the block normally (no batching applies)
 *   - `{ kind: 'batch_start', calls }` → render the consolidated batch row
 *     at this index, then skip ahead through subsequent `batch_member` slots
 *   - `{ kind: 'batch_member' }` → return null (already covered by the
 *     preceding batch_start)
 *
 * Batching rule: consecutive `tool_call` blocks resolving to the same
 * large_result id batch together, AND reasoning blocks sitting between
 * those reads are "swallowed" into the batch (rendered as nothing). Short
 * per-read planning chunks like "I'll read offset 28000 next" become pure
 * noise in the chat once the consolidated range pills tell the same story
 * — explicit user request to suppress them.
 *
 * What still breaks a batch: a `text` block (real assistant prose), a
 * non-read_large_result `tool_call`, or a `tool_call` with a different
 * large_result id. Those represent narrative state changes the developer
 * needs to see.
 */
export type ContentBlockDirective =
  | { kind: 'render' }
  | { kind: 'batch_start'; calls: ToolCallDisplay[] }
  | { kind: 'batch_member' }

/** Block types that can sit between two same-id reads without breaking
 *  the batch. Currently only `reasoning` — extend with caution; anything
 *  carrying user-visible narrative MUST break the batch. */
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
    const id = tc ? readLargeResultId(tc) : null
    if (!tc || id === null) { i += 1; continue }

    // Greedy look-ahead. Two-state walk: collect read_large_result calls
    // of the SAME id, swallowing reasoning blocks in between. Any other
    // block type (text, different tool, different id) commits the batch.
    const batchCalls: ToolCallDisplay[] = [tc]
    const swallowed: number[] = [] // reasoning indices consumed by this batch
    let j = i + 1
    while (j < blocks.length) {
      const nb = blocks[j]
      if (SWALLOWABLE_TYPES.has(nb.type)) {
        // Tentatively swallow — only commit if a same-id read follows.
        // Otherwise (reasoning is the last block, or followed by a
        // non-batchable block) the reasoning must render normally.
        let k = j + 1
        while (k < blocks.length && SWALLOWABLE_TYPES.has(blocks[k].type)) k += 1
        if (k >= blocks.length) break
        const candidate = blocks[k]
        if (candidate.type !== 'tool_call' || !candidate.toolCallId) break
        const candidateTc = resolveToolCall(candidate.toolCallId)
        if (!candidateTc || readLargeResultId(candidateTc) !== id) break
        // Commit: swallow [j..k-1], add the read at k, then continue.
        for (let s = j; s < k; s++) swallowed.push(s)
        batchCalls.push(candidateTc)
        j = k + 1
        continue
      }
      if (nb.type !== 'tool_call' || !nb.toolCallId) break
      const ntc = resolveToolCall(nb.toolCallId)
      if (!ntc || readLargeResultId(ntc) !== id) break
      batchCalls.push(ntc)
      j += 1
    }
    directives[i] = { kind: 'batch_start', calls: batchCalls }
    for (let k = i + 1; k < j; k++) directives[k] = { kind: 'batch_member' }
    for (const s of swallowed) directives[s] = { kind: 'batch_member' }
    i = j
  }
  return directives
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
