/**
 * Context-window math for the auto-compact heuristic and the ctx-pressure
 * indicator. Ported from claude-vaz (utils/context.ts +
 * services/compact/autoCompact.ts) — keeping the same constant names and
 * shapes so the IDE and Claude Code reason about the same numbers.
 *
 * Three constants own the boundary:
 *
 *   MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
 *     Reserved at the top of the window so a compaction call has room to
 *     emit its summary. Effective window = raw window minus this.
 *
 *   AUTOCOMPACT_BUFFER_FLOOR  = 13_000
 *   AUTOCOMPACT_BUFFER_PCT    = 0.05
 *     Safety margin below the effective ceiling. Threshold for auto-compact
 *     = effective window minus this. Buffer is adaptive: 13K floor on small
 *     windows (≤256K), 5% of effective on larger windows so the next turn
 *     still has room. On 1M: buffer = max(13K, ~49K) = 49K.
 *
 *   WARNING_THRESHOLD_BUFFER_FLOOR = 20_000
 *   WARNING_THRESHOLD_BUFFER_PCT   = 0.07
 *     Early-warning band — the UI's "orange" zone. claude-vaz uses a flat
 *     20K, which lands at 87 % of effective on a 256 K window but only at
 *     ~98 % on a 1 M window — by then the user has no actionable lead-time.
 *     The IDE's pill is the primary signal (claude-vaz has a fuller status
 *     line) so we want a more useful warn distance on large windows. The
 *     buffer scales: max(20K, effective × 7 %). On 128–256 K windows the
 *     floor wins (same behaviour as before). On 1 M it widens to ~69 K,
 *     so orange fires at ~92 % of effective instead of ~96 %.
 */

export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const AUTOCOMPACT_BUFFER_FLOOR = 13_000
export const AUTOCOMPACT_BUFFER_PCT = 0.05
export const WARNING_THRESHOLD_BUFFER_FLOOR = 20_000
export const WARNING_THRESHOLD_BUFFER_PCT = 0.07
export const BLOCKING_LIMIT_BUFFER = 3_000

/**
 * Window size minus the reserved headroom for the summary call.
 *
 * Models with a known max-output below 20 K shrink the reservation
 * accordingly — for windows we control, the summary itself can't be larger
 * than the model's own output cap.
 */
export function getEffectiveContextWindowSize(
  contextWindow: number,
  maxOutputTokens?: number | null,
): number {
  if (contextWindow <= 0) return 0
  const reserved = Math.min(
    maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return Math.max(0, contextWindow - reserved)
}

/**
 * Token count at which auto-compact fires. Compression should be
 * triggered when the current prompt size crosses this number — not
 * a percentage of the raw window.
 */
export function getAutoCompactThreshold(
  contextWindow: number,
  maxOutputTokens?: number | null,
): number {
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens)
  // Adaptive buffer: floor of 13K on small windows (≤256K), scales to 5% of
  // effective on larger windows. On 1M: buffer = max(13K, 49K) = 49K, giving
  // the next turn ~49K of breathing room instead of a dangerously tight 13K.
  const buffer = Math.max(
    AUTOCOMPACT_BUFFER_FLOOR,
    Math.floor(effective * AUTOCOMPACT_BUFFER_PCT),
  )
  return Math.max(0, effective - buffer)
}

/**
 * Warning threshold for the UI's "orange" zone — pre-compaction signal.
 * Lower than the auto-compact threshold so the user sees pressure
 * building before the IDE acts. Buffer is adaptive: floor of 20K on
 * small windows, scales to 7 % of effective on large windows so the
 * orange band stays visible on 1 M-context models.
 */
export function getWarningThreshold(
  contextWindow: number,
  maxOutputTokens?: number | null,
): number {
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens)
  const trigger = getAutoCompactThreshold(contextWindow, maxOutputTokens)
  const buffer = Math.max(
    WARNING_THRESHOLD_BUFFER_FLOOR,
    Math.floor(effective * WARNING_THRESHOLD_BUFFER_PCT),
  )
  return Math.max(0, trigger - buffer)
}

/**
 * Returns true when the context is so close to full that no useful reply
 * can fit. Blocks further user input until compaction runs.
 * Matches claude-vaz autoCompact.ts `isAtBlockingLimit` (tokens >=
 * contextWindow - 3000).
 */
export function isAtBlockingLimit(
  currentTokens: number,
  contextWindow: number,
): boolean {
  if (contextWindow <= 0) return false
  return currentTokens >= contextWindow - BLOCKING_LIMIT_BUFFER
}

/**
 * Sum the three on-wire input components into a single pressure number.
 * Matches claude-vaz/utils/context.ts:130-133 — cache reads and writes
 * occupy slots in the context window even though they bill differently.
 */
export function totalInputTokens(usage: {
  input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
} | null | undefined): number {
  if (!usage) return 0
  return (
    (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
  )
}

/**
 * Percentages over the effective window (claude-vaz shape). Returns null
 * fields when no usage has been observed yet so callers can render
 * "no signal" instead of a false 0 %.
 *
 * The denominator is the EFFECTIVE window, not raw. Once usage crosses
 * the effective ceiling there is no actual room left for a real reply —
 * any further input just steals from the reserved summary headroom.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens?: number | null
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  } | null,
  contextWindow: number,
  maxOutputTokens?: number | null,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens)
  if (effective <= 0) {
    return { used: null, remaining: null }
  }

  const total = totalInputTokens(currentUsage)
  const raw = Math.round((total / effective) * 100)
  const clampedUsed = Math.min(100, Math.max(0, raw))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}
