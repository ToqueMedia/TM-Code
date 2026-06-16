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
import {
  getAutoCompactThreshold as getRealAutoCompactThreshold,
  FALLBACK_CONTEXT_WINDOW,
} from '../../../utils/contextWindow'

// ── Constants ──

/** Stop trying autocompact after this many consecutive failures. */
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// The "unknown window" fallback (FALLBACK_CONTEXT_WINDOW = 200K) lives in
// utils/contextWindow.ts so the pill, the status line, the admin Select and this
// decision all share ONE value. resolveThreshold() routes it through the same
// real math — no duplicate constants or hardcoded 1M threshold here anymore.

// ── Types ──

export interface AutoCompactTrackingState {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
}

/**
 * Real model limits + real token occupancy, so the compaction decision tracks
 * the ACTIVE model instead of a hardcoded 1M window and a char-estimate.
 *
 * Why this exists (context pollution audit, 2026-06-12): the legacy path
 * hardcoded `MIMO_CONTEXT_WINDOW = 1_000_000` and triggered on
 * `tokenCountWithEstimation` (chars/4). On any smaller-window model the agent
 * believed it had 1M of room and could blow past the provider's real ceiling
 * (hard context-overflow) without ever compacting — and the char-estimate
 * ignored tool_call argument payloads entirely. When `contextWindow` is known
 * the threshold comes from utils/contextWindow.ts (the same adaptive math the
 * UI pressure pill uses) and the numerator is the MAX of the provider's real
 * occupancy and the char-estimate (never under-counts either signal).
 */
export interface AutoCompactLimits {
  /** Active model's real context window in tokens. null/undefined → legacy 1M fallback. */
  contextWindow?: number | null
  /** Active model's max output tokens (shrinks the reserved summary headroom). */
  maxOutputTokens?: number | null
  /**
   * Real context occupancy: the previous turn's provider `prompt_tokens` +
   * `completion_tokens` (cache-aware, counts everything the estimate misses).
   * Undefined on the first turn (no response seen yet) → estimate-only.
   */
  realOccupancyTokens?: number | null
}

/** True when we have a real context window to reason about. */
function hasRealWindow(limits?: AutoCompactLimits): limits is AutoCompactLimits & { contextWindow: number } {
  return !!limits && typeof limits.contextWindow === 'number' && limits.contextWindow > 0
}

/**
 * Threshold tokens that trigger compaction. Always routed through the single
 * source of truth (utils/contextWindow.ts): the real window when known, the
 * conservative FALLBACK_CONTEXT_WINDOW otherwise (never a 1M assumption).
 */
function resolveThreshold(limits?: AutoCompactLimits): number {
  return hasRealWindow(limits)
    ? getRealAutoCompactThreshold(limits.contextWindow, limits.maxOutputTokens)
    : getRealAutoCompactThreshold(FALLBACK_CONTEXT_WINDOW)
}

/** Best occupancy estimate: never below the provider's real reading nor the char-estimate. */
function resolveOccupancy(
  messages: MessageLike[],
  snipTokensFreed: number,
  limits?: AutoCompactLimits,
): number {
  const estimate = Math.max(0, tokenCountWithEstimation(messages) - snipTokensFreed)
  const real = limits?.realOccupancyTokens
  return typeof real === 'number' && real > 0 ? Math.max(estimate, real) : estimate
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
        // tool_call arguments — the agent emits large write_file/edit_file
        // payloads HERE, in the assistant's tool-call block. The old estimator
        // ignored them entirely, so a single big-edit turn could under-count
        // occupancy and slip past the auto-compact threshold → overflow on the
        // next turn. Count name + serialized arguments (string or input object).
        if (block.type === 'tool_call') {
          const b = block as { name?: string; arguments?: string; input?: unknown }
          const args = typeof b.arguments === 'string'
            ? b.arguments
            : b.input != null
              ? JSON.stringify(b.input)
              : ''
          total += roughTokenEstimate((b.name ?? '') + args)
        }
      }
    }
  }
  return total
}

// ── Core logic ──

/** Check whether auto-compact should fire based on current token usage. */
export function shouldAutoCompact(
  messages: MessageLike[],
  snipTokensFreed = 0,
  limits?: AutoCompactLimits,
): boolean {
  const tokenCount = resolveOccupancy(messages, snipTokensFreed, limits)
  const threshold = resolveThreshold(limits)
  const isAboveAutoCompactThreshold = tokenCount >= threshold

  if (isAboveAutoCompactThreshold) {
    const src = hasRealWindow(limits)
      ? `window=${limits.contextWindow}${limits.realOccupancyTokens ? ` real=${limits.realOccupancyTokens}` : ''}`
      : `window=fallback-${FALLBACK_CONTEXT_WINDOW}(estimate)`
    console.debug(
      `[autoCompact] threshold exceeded: tokens=${tokenCount} threshold=${threshold} ${src}`,
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
 * Summarize the given messages into a single post-compact user message.
 * Returns null when the summarizer produced nothing — the caller decides
 * whether to count a failure or fall back.
 *
 * Shared by the PROACTIVE autoCompact path (below) and the REACTIVE
 * prompt-too-long recovery in query.ts, so both produce the exact same
 * post-compact shape. Kept side-effect-free (no threshold/circuit-breaker
 * logic) so the reactive path can force a compaction it KNOWS is needed
 * (the provider already rejected the prompt).
 */
export async function compactNow(
  messages: MessageLike[],
  systemPrompt: string,
  compactFn: CompactFn,
): Promise<MessageLike[] | null> {
  const summary = await compactFn(messages, systemPrompt)
  if (!summary) return null
  const summaryContent = getCompactUserSummaryMessage(summary, true)
  return [{ role: 'user', content: summaryContent }]
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
  limits?: AutoCompactLimits,
): Promise<AutoCompactResult> {
  // Circuit breaker
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const shouldCompact = shouldAutoCompact(messages, snipTokensFreed, limits)

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const preCompactTokenCount = resolveOccupancy(messages, snipTokensFreed ?? 0, limits)

  try {
    const postCompactMessages = await compactNow(messages, systemPrompt, compactFn)

    if (!postCompactMessages) {
      const prevFailures = tracking?.consecutiveFailures ?? 0
      return {
        wasCompacted: false,
        consecutiveFailures: prevFailures + 1,
      }
    }

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
