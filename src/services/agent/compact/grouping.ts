/**
 * Groups messages at API-round boundaries for compact truncation.
 *
 * Ported from claude-vaz services/compact/grouping.ts — adapted for
 * TM Code's message format (role-based, no uuid/message.id).
 *
 * A boundary fires when a new assistant response begins. In TM Code,
 * assistant messages don't carry a persistent message.id like claude-vaz,
 * so we detect boundaries by looking for assistant messages that follow
 * a user message (i.e. a new API round-trip).
 *
 * This is used by:
 *   - PTL retry (truncateHeadForPTLRetry) to drop oldest round groups
 *   - Reactive compact to find safe split points
 */

import type { InternalMessage } from '../messageUtils'

/**
 * Group messages into API-round groups.
 *
 * Each group starts with the first message of an API round:
 *   group[0] = preamble (initial user message + early exchanges)
 *   group[N] = assistant response + subsequent tool results + next user turn
 *
 * A new group begins whenever an assistant message follows a user message
 * (signalling a new API round-trip).
 */
export function groupMessagesByApiRound(messages: InternalMessage[]): InternalMessage[][] {
  const groups: InternalMessage[][] = []
  let current: InternalMessage[] = []
  let lastRole: 'user' | 'assistant' | undefined

  for (const msg of messages) {
    // New round: assistant follows user (and we already have messages in current group)
    if (msg.role === 'assistant' && lastRole === 'user' && current.length > 0) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    lastRole = msg.role
  }

  if (current.length > 0) {
    groups.push(current)
  }

  return groups
}
