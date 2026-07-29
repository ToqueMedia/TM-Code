/**
 * Snip compact — surgical tail-cut of message history.
 *
 * Removes the oldest conversation turns while preserving recent context.
 * Unlike auto-compact (which summarizes via an API call), snip simply
 * drops old messages to free tokens quickly and cheaply.
 *
 * Pattern from claude-vaz: snip removes old user/assistant pairs from
 * the head of the message array, keeping the most recent N turns intact.
 */

import type { ContentBlockAPI } from '../../../types/chat'

// ── Types ──

/** Minimal message shape for snip. */
interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

export interface SnipResult {
  messages: MessageLike[]
  tokensFreed: number
  messagesRemoved: number
}

export interface SnipOptions {
  /** Minimum number of recent messages to keep. Default: 20. */
  keepRecentMessages?: number
  /** Target token count after snip. Default: 50% of effective window. */
  targetTokens?: number
  /** Force snip regardless of token threshold. */
  force?: boolean
}

// ── Constants ──

const DEFAULT_KEEP_RECENT = 20
const DEFAULT_TARGET_TOKEN_RATIO = 0.5

/** Rough token estimate: ~4 chars per token, padded 4/3. */
function roughTokenEstimate(text: string): number {
  return Math.ceil((text.length / 4) * (4 / 3))
}

function messageTokens(msg: MessageLike): number {
  if (typeof msg.content === 'string') return roughTokenEstimate(msg.content)
  if (!Array.isArray(msg.content)) return 0
  return msg.content.reduce((sum, block) => {
    if (block.type === 'text') return sum + roughTokenEstimate(block.text)
    if (block.type === 'tool_result' && typeof block.content === 'string') {
      return sum + roughTokenEstimate(block.content)
    }
    if (block.type === 'thinking') return sum + roughTokenEstimate(block.thinking)
    if (block.type === 'tool_call') return sum + 50 // Rough estimate for tool schemas
    return sum
  }, 0)
}

function totalTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, msg) => sum + messageTokens(msg), 0)
}

// ── Core ──

/**
 * Find a safe snip boundary — never split a tool_call from its tool_result.
 *
 * Walks forward from the desired cut point to find the next user message
 * that doesn't start with a tool_result (which would orphan a tool_call
 * in the removed portion).
 */
function findSafeCutPoint(
  messages: MessageLike[],
  desiredIndex: number,
): number {
  let i = desiredIndex
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role !== 'user') {
      i++
      continue
    }

    // Check if this user message starts with a tool_result
    if (Array.isArray(msg.content)) {
      const firstBlock = msg.content[0]
      if (firstBlock && firstBlock.type === 'tool_result') {
        // This user message is a tool_result — can't cut here, it
        // belongs to a tool_use in the preceding assistant message
        i++
        continue
      }
    }

    // Safe to cut here — this is a regular user message
    return i
  }

  // No safe cut point found — don't snip
  return messages.length
}

/**
 * Apply snip compaction: remove oldest turns while preserving recent context.
 *
 * Returns the modified messages array and metadata about what was removed.
 */
export function snipCompactIfNeeded(
  messages: MessageLike[],
  options?: SnipOptions,
): SnipResult {
  const opts = options ?? {}
  const keepRecent = opts.keepRecentMessages ?? DEFAULT_KEEP_RECENT

  if (messages.length <= keepRecent) {
    return { messages, tokensFreed: 0, messagesRemoved: 0 }
  }

  const currentTokens = totalTokens(messages)
  const targetTokens = opts.targetTokens
    ? opts.targetTokens
    : Math.floor(currentTokens * DEFAULT_TARGET_TOKEN_RATIO)

  // Only snip if we're over target (unless forced)
  if (!opts.force && currentTokens <= targetTokens) {
    return { messages, tokensFreed: 0, messagesRemoved: 0 }
  }

  // Calculate the desired cut point: remove everything before the last
  // `keepRecent` messages, or cut enough to reach targetTokens
  const desiredCutIndex = Math.max(0, messages.length - keepRecent)

  // Find a safe boundary
  const cutIndex = findSafeCutPoint(messages, desiredCutIndex)

  if (cutIndex >= messages.length) {
    return { messages, tokensFreed: 0, messagesRemoved: 0 }
  }

  // Also ensure we never leave a dangling assistant message at the start
  // (the API expects user messages to start the conversation)
  let finalCutIndex = cutIndex
  while (
    finalCutIndex < messages.length &&
    messages[finalCutIndex].role !== 'user'
  ) {
    finalCutIndex++
  }

  if (finalCutIndex >= messages.length) {
    return { messages, tokensFreed: 0, messagesRemoved: 0 }
  }

  const removed = messages.slice(0, finalCutIndex)
  const kept = messages.slice(finalCutIndex)
  const tokensFreed = removed.reduce((sum, msg) => sum + messageTokens(msg), 0)

  // MARCADOR (auditoria 2026-07-29): o snip devolvia `kept` cru, portanto o
  // modelo recebia uma conversa que começava a meio e não tinha como saber
  // que algo tinha sido cortado. Isso não é economia, é amnésia com cara de
  // conversa completa: o modelo re-deriva decisões já tomadas, contradiz
  // acordos anteriores e não pede o que perdeu — porque não sabe que perdeu.
  // Ao contrário do auto-compact, o snip não resume nada, logo o marcador é a
  // ÚNICA pista que resta. Vai como bloco de texto no início da primeira
  // mensagem mantida (que é sempre `user`, garantido acima) e não como
  // mensagem nova, para não criar dois `user` seguidos.
  const marker = `<system-reminder>\n`
    + `${removed.length} earlier message${removed.length === 1 ? '' : 's'} `
    + `(~${tokensFreed} tokens) were dropped from this conversation to free context. `
    + `They were NOT summarized — that content is gone. If you need something from the earlier part of `
    + `this session, call read_session_memory or re-read the relevant files instead of assuming. `
    + `Do not claim to remember what was cut.\n</system-reminder>`

  const first = kept[0]
  const markedFirst: MessageLike = typeof first.content === 'string'
    ? { ...first, content: `${marker}\n\n${first.content}` }
    : {
      ...first,
      content: [
        { type: 'text', text: marker } as ContentBlockAPI,
        ...(Array.isArray(first.content) ? first.content : []),
      ],
    }

  return {
    messages: [markedFirst, ...kept.slice(1)],
    tokensFreed,
    messagesRemoved: removed.length,
  }
}
