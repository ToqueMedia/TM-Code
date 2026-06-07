/**
 * Tool result budget — aggregate size limit for tool results per message.
 *
 * Simplified port from claude-vaz utils/toolResultStorage.ts.
 *
 * When the total size of tool results in a single user message exceeds
 * the budget, the largest results are truncated to keep the conversation
 * within manageable bounds.
 */

import type { ContentBlockAPI } from '../../../types/chat'

// ── Constants ──

/** Default per-message budget: 200K chars (~50K tokens). */
const DEFAULT_BUDGET_CHARS = 200_000

/** Minimum kept content per truncated result. */
const MIN_KEEP_CHARS = 500

/** Placeholder for truncated content. */
const TRUNCATED_MARKER = '\n\n[... content truncated by tool result budget ...]'

// ── Types ──

interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

// ── Core ──

/**
 * Apply per-message tool result budget.
 *
 * For each user message, sums all tool_result content sizes. When the
 * total exceeds the budget, truncates the largest results proportionally
 * until the message is within budget.
 *
 * This is a simplified version — the claude-vaz implementation has
 * persistent state across turns for prompt cache stability. TM Code
 * applies a fresh budget each time (no cross-turn state).
 *
 * @param messages - Conversation messages to process
 * @param budgetChars - Max chars per message (default: 200K)
 * @returns Messages with budget applied (may return same array if no changes)
 */
export function applyToolResultBudget(
  messages: MessageLike[],
  budgetChars: number = DEFAULT_BUDGET_CHARS,
): MessageLike[] {
  let anyChanged = false

  const result = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg

    const blocks = msg.content as ContentBlockAPI[]

    // Collect tool_result blocks with their sizes
    const toolResultIndices: { index: number; size: number }[] = []
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        toolResultIndices.push({ index: i, size: block.content.length })
      }
    }

    if (toolResultIndices.length === 0) return msg

    const totalSize = toolResultIndices.reduce((sum, tr) => sum + tr.size, 0)

    if (totalSize <= budgetChars) return msg

    // Over budget — truncate largest results
    anyChanged = true

    // Sort by size descending for truncation priority
    const sorted = [...toolResultIndices].sort((a, b) => b.size - a.size)

    // Calculate how much to remove
    const excess = totalSize - budgetChars
    let remaining = excess
    const newBlocks = [...blocks]

    for (const entry of sorted) {
      if (remaining <= 0) break

      const block = newBlocks[entry.index] as { type: 'tool_result'; toolCallId: string; content: string }
      const originalSize = block.content.length

      if (originalSize <= MIN_KEEP_CHARS) continue

      // Truncate proportionally: remove `remaining / entries_left` chars
      const toRemove = Math.min(remaining, originalSize - MIN_KEEP_CHARS)
      const keepChars = originalSize - toRemove

      newBlocks[entry.index] = {
        ...block,
        content: block.content.slice(0, keepChars) + TRUNCATED_MARKER,
      }

      remaining -= toRemove
    }

    return { ...msg, content: newBlocks }
  })

  return anyChanged ? result : messages
}
