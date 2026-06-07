/**
 * Context collapse — persistent turn-summary projections.
 *
 * Ported from claude-vaz services/contextCollapse/ pattern.
 *
 * Context collapse maintains a sidecar store of turn-level summaries.
 * When context grows large, it commits staged collapses that replace
 * older turns with summaries while keeping granular recent context.
 *
 * The collapse is "staged" — summaries are computed eagerly but only
 * applied to the message array when a threshold is crossed. This gives
 * us fast recovery from prompt-too-long without a round-trip to the
 * summarization API at the moment of crisis.
 *
 * Feature-gated: defaults to OFF. Enable via setContextCollapseEnabled(true).
 */

import type { ContentBlockAPI } from '../../../types/chat'

// ── Types ──

interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

export interface CollapseResult {
  messages: MessageLike[]
  /** Number of collapses committed this call. */
  committed: number
}

// ── Configuration ──

/** Minimum messages before collapse considers acting. */
const COLLAPSE_THRESHOLD = 40
/** Number of recent messages to always keep intact. */
const KEEP_RECENT = 20
/** Minimum messages in the "old" region to bother collapsing. */
const MIN_COLLAPSIBLE = 8

// ── Feature gate ──

let _enabled = false

/** Enable or disable context collapse. */
export function setContextCollapseEnabled(enabled: boolean): void {
  _enabled = enabled
}

export function isContextCollapseEnabled(): boolean {
  return _enabled
}

// ── Sidecar store ──

/**
 * Staged summaries keyed by the index of the first message they replace.
 * When a collapse is committed, entries are removed from this store and
 * the corresponding messages are replaced in the array.
 */
const stagedSummaries = new Map<number, string>()

/** Whether a prompt-too-long was withheld (pending collapse drain). */
let withheldPromptTooLong = false

/**
 * Reset all staged collapses. Called after auto-compact or manual compact
 * invalidates the message indices.
 */
export function resetContextCollapse(): void {
  stagedSummaries.clear()
  withheldPromptTooLong = false
}

/**
 * Mark that a prompt-too-long error was withheld for later collapse drain.
 */
export function withholdPromptTooLong(): void {
  withheldPromptTooLong = true
}

/**
 * Check if a prompt-too-long was withheld.
 */
export function isWithheldPromptTooLong(): boolean {
  return withheldPromptTooLong
}

// ── Staging ──

/**
 * Stage a collapse summary for a range of messages.
 * The summary will be committed when applyCollapsesIfNeeded() runs
 * and the threshold is crossed.
 */
export function stageCollapse(
  startIndex: number,
  endIndex: number,
  summary: string,
): void {
  if (startIndex >= endIndex) return
  stagedSummaries.set(startIndex, summary)
}

// ── Core ──

/**
 * Apply context collapse if needed.
 *
 * When message count exceeds COLLAPSE_THRESHOLD and there are staged
 * collapses, commit them by replacing old messages with summary messages.
 *
 * If no staged collapses exist, this is a pass-through.
 */
export function applyCollapsesIfNeeded(
  messages: MessageLike[],
): CollapseResult {
  if (!_enabled) {
    return { messages, committed: 0 }
  }

  // Nothing staged — nothing to commit
  if (stagedSummaries.size === 0) {
    return { messages, committed: 0 }
  }

  // Below threshold — don't commit yet (keep accumulating stages)
  if (messages.length < COLLAPSE_THRESHOLD) {
    return { messages, committed: 0 }
  }

  return commitStagedCollapses(messages)
}

/**
 * Recover from prompt-too-long by draining all staged collapses.
 *
 * This is more aggressive than applyCollapsesIfNeeded — it commits
 * regardless of threshold. Used when the API rejects with prompt_too_long.
 */
export function recoverFromOverflow(
  messages: MessageLike[],
): { messages: MessageLike[]; committed: number } {
  if (stagedSummaries.size === 0) {
    withheldPromptTooLong = false
    return { messages, committed: 0 }
  }

  const result = commitStagedCollapses(messages)
  withheldPromptTooLong = false
  return result
}

// ── Internal ──

/**
 * Commit all staged collapses into the message array.
 *
 * Strategy:
 * 1. Sort staged entries by index (ascending)
 * 2. Replace the message range with a single summary message
 * 3. Adjust subsequent indices for the removed messages
 * 4. Clear the staged store
 */
function commitStagedCollapses(
  messages: MessageLike[],
): CollapseResult {
  // Sort by index ascending
  const entries = [...stagedSummaries.entries()].sort((a, b) => a[0] - b[0])

  if (entries.length === 0) {
    return { messages, committed: 0 }
  }

  const result: MessageLike[] = [...messages]
  let offset = 0
  let committed = 0

  for (const [origIndex, summary] of entries) {
    const adjustedIndex = origIndex - offset

    // Safety: don't collapse into the recent zone
    if (adjustedIndex >= result.length - KEEP_RECENT) break
    if (adjustedIndex < 0) continue

    // Find how many messages this summary replaces.
    // Look for the next staged entry or KEEP_RECENT boundary.
    const nextEntry = entries.find(([idx]) => idx > origIndex)
    const endOrig = nextEntry ? nextEntry[0] : Math.min(
      messages.length - KEEP_RECENT,
      origIndex + MIN_COLLAPSIBLE,
    )
    const endAdjusted = endOrig - offset

    if (endAdjusted <= adjustedIndex) continue
    if (endAdjusted > result.length - KEEP_RECENT) continue

    // Replace the range [adjustedIndex, endAdjusted) with a summary
    const removedCount = endAdjusted - adjustedIndex
    const summaryMessage: MessageLike = {
      role: 'user',
      content: `[Context Collapse — ${removedCount} messages summarized]\n\n${summary}`,
    }

    result.splice(adjustedIndex, removedCount, summaryMessage)

    // Add a placeholder assistant response so alternation is maintained
    result.splice(adjustedIndex + 1, 0, {
      role: 'assistant',
      content: 'Understood. I have the collapsed context.',
    })

    offset += removedCount - 2 // removed N, added 2 (summary + placeholder)
    committed++
  }

  // Clear all staged entries
  stagedSummaries.clear()

  return { messages: result, committed }
}
