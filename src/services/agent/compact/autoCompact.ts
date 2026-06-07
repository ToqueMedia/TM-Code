/**
 * Auto-compact — token-threshold-based conversation compaction.
 *
 * Ported from claude-vaz services/compact/autoCompact.ts, adapted for
 * TM Code (no Bun features, fixed model context window, simplified flow).
 *
 * When token usage crosses the auto-compact threshold, fires a
 * summarization side-call that compresses the conversation into a
 * single user summary message.
 */

import type { ContentBlockAPI } from '../../../types/chat'
import { getCompactUserSummaryMessage } from './prompt'
import { isContextCollapseEnabled } from '../collapse'

// ── Constants ──

/** Reserve this many tokens for model output during compaction. */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/** Buffer below effective context window to trigger auto-compact. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/** Warning threshold buffer. */
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000

/** Error threshold buffer. */
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000

/** Manual compact buffer — reserve space so user can still run /compact. */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

/** Stop trying autocompact after this many consecutive failures. */
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// ── MiMo v2.5 Pro context window ──

/** Context window for mimo-v2.5-pro-1m (1M tokens). */
const MIMO_CONTEXT_WINDOW = 1_000_000

/** Max output tokens for the model. */
const MAX_OUTPUT_TOKENS = 32_768

// ── Types ──

export interface AutoCompactTrackingState {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
}

/** Minimal message shape for auto-compact. */
interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

// ── Token estimation ──

/** Rough token estimate: ~4 chars per token, padded 4/3. */
function roughTokenEstimate(text: string): number {
  return Math.ceil((text.length / 4) * (4 / 3))
}

/** Estimate total tokens across all messages. */
export function tokenCountWithEstimation(messages: MessageLike[]): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += roughTokenEstimate(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') total += roughTokenEstimate(block.text)
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          total += roughTokenEstimate(block.content)
        }
        if (block.type === 'thinking') {
          total += roughTokenEstimate(block.thinking)
        }
      }
    }
  }
  return total
}

// ── Context window helpers ──

/** Effective context window = context window minus reserved output tokens. */
export function getEffectiveContextWindowSize(): number {
  const reservedForSummary = Math.min(MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  return MIMO_CONTEXT_WINDOW - reservedForSummary
}

/** Token threshold that triggers auto-compact. */
export function getAutoCompactThreshold(): number {
  return getEffectiveContextWindowSize() - AUTOCOMPACT_BUFFER_TOKENS
}

// ── Warning state ──

export function calculateTokenWarningState(tokenUsage: number): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold()
  const threshold = autoCompactThreshold
  const effectiveWindow = getEffectiveContextWindowSize()

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold
  const isAboveAutoCompactThreshold = tokenUsage >= autoCompactThreshold
  const blockingLimit = effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS
  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

// ── Core logic ──

/** Check whether auto-compact should fire based on current token usage. */
export function shouldAutoCompact(
  messages: MessageLike[],
  snipTokensFreed = 0,
): boolean {
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold()
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount)

  if (isAboveAutoCompactThreshold) {
    console.debug(
      `[autoCompact] threshold exceeded: tokens=${tokenCount} threshold=${threshold}`,
    )
  }

  return isAboveAutoCompactThreshold
}

/** Callback to perform the actual compaction (summarization API call). */
export type CompactFn = (
  messages: MessageLike[],
  systemPrompt: string,
) => Promise<string | null>

export interface AutoCompactResult {
  wasCompacted: boolean
  /** Post-compact messages (summary user message) when compacted. */
  postCompactMessages?: MessageLike[]
  /** Token counts for telemetry. */
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  consecutiveFailures?: number
}

/**
 * Auto-compact if token threshold is exceeded.
 *
 * Uses a circuit breaker: after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
 * stops retrying to avoid wasting API calls.
 *
 * @param messages - Current conversation messages
 * @param systemPrompt - System prompt for the summarization call
 * @param compactFn - Function that performs the actual summarization
 * @param tracking - Cross-iteration tracking state
 * @param snipTokensFreed - Tokens already freed by snip
 */
export async function autoCompact(
  messages: MessageLike[],
  systemPrompt: string,
  compactFn: CompactFn,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<AutoCompactResult> {
  // When context collapse is active, it handles context management instead of auto-compact
  if (isContextCollapseEnabled()) {
    return { wasCompacted: false }
  }

  // Circuit breaker
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const shouldCompact = shouldAutoCompact(messages, snipTokensFreed)

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const preCompactTokenCount = tokenCountWithEstimation(messages) - (snipTokensFreed ?? 0)

  try {
    const summary = await compactFn(messages, systemPrompt)

    if (!summary) {
      const prevFailures = tracking?.consecutiveFailures ?? 0
      return {
        wasCompacted: false,
        consecutiveFailures: prevFailures + 1,
      }
    }

    // Build post-compact messages: single user message with the summary
    const summaryContent = getCompactUserSummaryMessage(summary, true)
    const postCompactMessages: MessageLike[] = [
      { role: 'user', content: summaryContent },
    ]

    const postCompactTokenCount = tokenCountWithEstimation(postCompactMessages)

    console.debug(
      `[autoCompact] compacted: ${preCompactTokenCount} -> ${postCompactTokenCount} tokens`,
    )

    return {
      wasCompacted: true,
      postCompactMessages,
      preCompactTokenCount,
      postCompactTokenCount,
      consecutiveFailures: 0,
    }
  } catch (error) {
    console.error('[autoCompact] compaction failed:', error)
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      console.warn(
        `[autoCompact] circuit breaker tripped after ${nextFailures} consecutive failures`,
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
