/**
 * Message utilities — shared pure functions for message manipulation.
 *
 * SRP: filtering orphaned tool_call blocks from conversation history.
 * Used by query.ts (QueryMessage) and agentService.
 */

import type { ContentBlockAPI } from '../../types/chat'

/** Internal message shape used by message utilities and agent subsystems. */
export interface InternalMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

/**
 * Filter out assistant messages that contain tool_call blocks without
 * matching tool_result blocks in subsequent user messages.
 *
 * The API rejects requests where tool_call blocks are "orphaned"
 * (no corresponding tool_result), so we strip them before sending.
 */
export function filterIncompleteToolCalls(messages: InternalMessage[]): InternalMessage[] {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === 'tool_call') toolUseIds.add(block.id)
      if (block.type === 'tool_result') toolResultIds.add(block.toolCallId)
    }
  }

  const orphanedIds = new Set(
    [...toolUseIds].filter(id => !toolResultIds.has(id)),
  )

  if (orphanedIds.size === 0) return messages

  return messages.map(msg => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
    const filtered = (msg.content as ContentBlockAPI[]).filter(
      block => !(block.type === 'tool_call' && orphanedIds.has(block.id)),
    )
    if (filtered.length === (msg.content as ContentBlockAPI[]).length) return msg
    return { ...msg, content: filtered.length > 0 ? filtered : '' }
  })
}
