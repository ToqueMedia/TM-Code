/**
 * Microcompact — keep recent tool results in full, content-clear older ones.
 *
 * Ported from claude-vaz services/compact/microCompact.ts, adapted for
 * TM Code's ContentBlockAPI message format.
 *
 * Strategy:
 *   - Walk messages, collect tool_call IDs from compactable tools
 *   - Keep the last N tool results in full (configurable)
 *   - Content-clear older results with a placeholder string
 *   - Time-based trigger: when idle > threshold, aggressively clear
 */

import type { ContentBlockAPI } from '../../../types/chat'

export const CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * Tool names whose results are eligible for microcompaction. MUST match the
 * names TM Code's toolExecutor actually registers — the port from claude-vaz
 * kept its generic names (`bash`, `grep`, `terminal`), which match NOTHING here,
 * so the two heaviest outputs (`execute_command` shell output and `search_files`
 * results) were never cleared and microcompact freed far less than it should.
 * Canonical names: see src/services/agent/toolExecutor.ts.
 */
const COMPACTABLE_TOOLS = new Set([
  'read_file',
  'execute_command', // shell output — the biggest single context hog
  'search_files',    // grep/rg results — also large
  'glob',
  'list_directory',
  'web_fetch',
  'web_search',
  'edit_file',
  'write_file',
  'create_file',
])

export interface MicrocompactResult {
  messages: MessageLike[]
  tokensSaved: number
  clearedCount: number
}

/** Minimal message shape for microcompact — avoids importing full chat types. */
interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

/** Estimate tokens from a string (~4 chars per token, padded 4/3). */
function roughTokenEstimate(text: string): number {
  return Math.ceil((text.length / 4) * (4 / 3))
}

/** Collect tool_call IDs from compactable tools across all assistant messages. */
function collectCompactableToolIds(messages: MessageLike[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as ContentBlockAPI[]) {
      if (block.type === 'tool_call' && COMPACTABLE_TOOLS.has(block.name)) {
        ids.push(block.id)
      }
    }
  }
  return ids
}

export interface MicrocompactOptions {
  /** Number of recent compactable tool results to keep in full. Default: 8. */
  keepRecent?: number
  /** Gap in ms since last assistant message to trigger aggressive clear. Default: 3600000 (60min). */
  gapThresholdMs?: number
  /** When gap fires, keep only this many recent results. Default: 5. */
  gapKeepRecent?: number
}

const DEFAULT_OPTIONS: Required<MicrocompactOptions> = {
  keepRecent: 8,
  gapThresholdMs: 60 * 60 * 1000, // 60 min — matches upstream prompt-cache TTL
  gapKeepRecent: 5,
}

/**
 * Apply microcompaction to messages.
 *
 * Walks messages, identifies compactable tool results, and content-clears
 * all but the most recent N. When the time gap since the last assistant
 * message exceeds the threshold, uses a more aggressive keep count.
 */
export function microcompact(
  messages: MessageLike[],
  options?: MicrocompactOptions,
): MicrocompactResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const compactableIds = collectCompactableToolIds(messages)

  if (compactableIds.length === 0) {
    return { messages, tokensSaved: 0, clearedCount: 0 }
  }

  // keepRecent is computed by the caller (computeMicrocompactKeepRecent in
  // contextManager), which folds in BOTH message density AND the idle-gap /
  // cold-cache eviction using the real last-assistant timestamp the query loop
  // tracks. This function just applies that count. The old in-here time-based
  // branch was a literal no-op (no timestamp on the message shape) and is gone;
  // gapThresholdMs/gapKeepRecent on the options remain only for standalone
  // callers that don't pre-compute keepRecent.
  const keepCount = Math.max(1, opts.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepCount))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return { messages, tokensSaved: 0, clearedCount: 0 }
  }

  let tokensSaved = 0
  let clearedCount = 0

  const result: MessageLike[] = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg

    let touched = false
    const newContent = (msg.content as ContentBlockAPI[]).map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.toolCallId) &&
        block.content !== CLEARED_MESSAGE
      ) {
        tokensSaved += typeof block.content === 'string'
          ? roughTokenEstimate(block.content)
          : 0
        touched = true
        clearedCount++
        return { ...block, content: CLEARED_MESSAGE }
      }
      return block
    })

    if (!touched) return msg
    return { ...msg, content: newContent }
  })

  return { messages: result, tokensSaved, clearedCount }
}
