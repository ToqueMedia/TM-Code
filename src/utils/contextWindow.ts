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
 *
 * PRESSURE MEASUREMENT (v0.7.2 fix):
 *
 *   The context window holds BOTH input and output tokens. The provider's
 *   `prompt_tokens` includes the full conversation history (previous user
 *   messages + previous assistant messages + tool results), so it already
 *   accounts for past outputs. However, the CURRENT turn's output tokens
 *   are NOT yet in `prompt_tokens` — they'll only appear in the NEXT turn's
 *   `prompt_tokens`. Therefore, true context occupancy at any point is:
 *
 *     pressureTokens = inputTokens + currentResponseTokens
 *
 *   This gives an accurate "how full is the window right now" measurement
 *   that reflects long reasoning/answer generations in real-time, rather
 *   than only showing the spike after the next turn starts.
 */

export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/**
 * Conservative context-window assumption used EVERYWHERE the real window is
 * unknown — no server `X-Model-Context-Window` header AND no matching entry in
 * MODEL_PROFILES (turn-1 pre-handshake, BYOK, or a renamed/new model id). The
 * pressure pill, the terminal status line, the auto-compact decision and the
 * admin Select default all fall back to this single value so they never
 * disagree. 200K (not 1M): when we genuinely don't know, compacting early is
 * safe; assuming 1M was the bug that let small-window models overflow. The
 * admin publishes the real window via Settings → Admin to override it.
 */
// The real context window is whatever the ADMIN publishes per active model in
// Settings → Admin (X-Model-Context-Window: 128k / 200k / 256k / 512k / 768k /
// 1M / 2M). The IDE NEVER caps or second-guesses that value — a 256K model is
// 256K, a 1M model is 1M. FALLBACK is used ONLY when no window is known at all
// (pre-handshake / unknown model), never to override a published window. If a
// large window makes the pill feel flat, the lever is the admin Select, not a
// hardcoded ceiling here.
export const FALLBACK_CONTEXT_WINDOW = 200_000

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
  const baseReserved = maxOutputTokens && maxOutputTokens > 0
    ? Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY)
    : MAX_OUTPUT_TOKENS_FOR_SUMMARY

  // Adaptive reserved headroom: if the context window is small (<= 64K),
  // we scale down the headroom to be at most 20% of the context window.
  // This ensures effective context window is never choked or negative.
  const reserved = contextWindow <= 64_000
    ? Math.min(baseReserved, Math.floor(contextWindow * 0.20))
    : baseReserved

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
  // If the effective window itself is small (<= 64K), we scale down the floor
  // buffer to 15% of the effective window to prevent it from choking the space.
  const baseBufferFloor = effective <= 64_000
    ? Math.floor(effective * 0.15)
    : AUTOCOMPACT_BUFFER_FLOOR

  const buffer = Math.max(
    baseBufferFloor,
    Math.floor(effective * AUTOCOMPACT_BUFFER_PCT),
  )
  return Math.max(0, effective - buffer)
}

/**
 * Fatia da janela EFETIVA que os tool results podem ocupar no pedido.
 *
 * PORQUÊ ISTO É UMA PERCENTAGEM E NÃO UM NÚMERO (2026-07-31)
 * ─────────────────────────────────────────────────────────
 * A janela real é publicada pelo admin por modelo (X-Model-Context-Window:
 * 128k … 2M) e todo o resto desta ficheiro já a respeita — limiar de
 * auto-compactação, aviso, limite de bloqueio. O orçamento de tool results era
 * a exceção: 40.000 tokens fixos, chamados sem opções em query.ts.
 *
 * Isso está errado nos dois sentidos. Num modelo de 1M, 40K são 4% da janela:
 * destruía-se o working set e pagava-se a reescrita do prefixo com 950K vazios
 * ao lado — e o modelo voltava a ler ficheiros que já tinha, que é exatamente a
 * dança que o módulo do orçamento diz existir para evitar. Num modelo de 128K,
 * 40K são 31% da janela, e somados ao system prompt + tools a auto-compactação
 * disparava muito antes do necessário.
 *
 * 30% da janela efetiva: em 200K dá ~54K (perto do valor antigo, ligeiramente
 * mais generoso), em 1M dá ~285K, em 128K dá ~32K. Sem piso — numa janela
 * pequena, 30% JÁ é a resposta certa, e um piso em tokens absolutos
 * sobre-alocaria precisamente onde o espaço é mais escasso.
 */
export const TOOL_RESULT_BUDGET_PCT = 0.30

/**
 * Teto absoluto do orçamento. Acima disto, manter mais resultados completos no
 * prompt custa mais por turno (latência incluída) do que reler de vez em
 * quando. Segura os 2M sem estragar os 1M.
 */
export const TOOL_RESULT_BUDGET_MAX = 250_000

/** Orçamento de tool results para a janela ativa. */
export function getToolResultBudgetTokens(
  contextWindow: number,
  maxOutputTokens?: number | null,
): number {
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens)
  if (effective <= 0) return 0
  return Math.min(
    Math.floor(effective * TOOL_RESULT_BUDGET_PCT),
    TOOL_RESULT_BUDGET_MAX,
  )
}

/**
 * Teto do bloco de recuperação pós-compactação, em CARACTERES.
 *
 * Também tem de seguir a janela: 60.000 caracteres (~16K tokens) são ruído num
 * modelo de 1M e são 12% da janela num de 128K — injetados no instante a seguir
 * a uma compactação que existiu para libertar espaço, ou seja, no pior momento
 * possível para voltar a cruzar o limiar.
 *
 * 8% da janela efetiva, convertidos a caracteres pelo mesmo rácio medido que o
 * estimador usa (ver CHARS_PER_TOKEN_ESTIMATE), com teto para o bloco não se
 * tornar um despejo em janelas enormes.
 */
export const POST_COMPACT_RECOVERY_PCT = 0.08
export const POST_COMPACT_RECOVERY_MAX_CHARS_CAP = 240_000

export function getPostCompactRecoveryMaxChars(
  contextWindow: number,
  maxOutputTokens?: number | null,
): number {
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens)
  if (effective <= 0) return 0
  const tokens = Math.floor(effective * POST_COMPACT_RECOVERY_PCT)
  return Math.min(tokens * 4, POST_COMPACT_RECOVERY_MAX_CHARS_CAP)
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

  // Adaptive warning buffer: scale down floor if effective window is small (<= 64K)
  const baseWarningFloor = effective <= 64_000
    ? Math.floor(effective * 0.10)
    : WARNING_THRESHOLD_BUFFER_FLOOR

  const buffer = Math.max(
    baseWarningFloor,
    Math.floor(effective * WARNING_THRESHOLD_BUFFER_PCT),
  )
  return Math.max(0, trigger - buffer)
}

/**
 * Returns true when the context is so close to full that no useful reply
 * can fit. Blocks further user input until compaction runs.
 *
 * Uses the EFFECTIVE window (raw minus summary headroom) as the
 * denominator — consistent with the auto-compact threshold and the
 * pressure pill. The previous version used the raw window, which
 * meant blocking could fire ~20K tokens later than the effective
 * ceiling, creating a gap where the user was blocked but the pill
 * hadn't shown 100%.
 */
export function isAtBlockingLimit(
  currentTokens: number,
  contextWindow: number,
  maxOutputTokens?: number | null,
): boolean {
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens)
  if (effective <= 0) return false
  return currentTokens >= effective - BLOCKING_LIMIT_BUFFER
}

/**
 * Sum the on-wire input components into a single pressure number.
 *
 * NOTE: This measures INPUT tokens only. For context-window pressure,
 * use `totalContextTokens()` below which adds the current turn's output
 * tokens — the window holds both, and the current output isn't yet
 * reflected in `prompt_tokens` (it rolls into the next turn's input).
 */
export function totalInputTokens(usage: {
  prompt_tokens?: number | null
} | null | undefined): number {
  if (!usage) return 0
  return usage.prompt_tokens ?? 0
}

/**
 * True context occupancy: input tokens (which include all previous
 * history — past user messages, past assistant outputs, tool results)
 * PLUS the current turn's output tokens (which aren't yet in prompt_tokens
 * because they only roll into the next turn's prompt).
 *
 * This is the correct numerator for context-pressure calculations.
 * Using only `totalInputTokens` understates pressure mid-turn — a
 * 80K input + 15K output response looks like 33% on a 256K window,
 * but the real occupancy is 95K ≈ 39%, and the NEXT turn will start
 * at 95K+ because those output tokens become part of the prompt.
 */
export function totalContextTokens(
  inputTokens: number,
  outputTokens: number,
): number {
  return inputTokens + outputTokens
}

/**
 * Percentages over the effective window. Returns null fields when no
 * usage has been observed yet so callers can render "no signal" instead
 * of a false 0 %.
 *
 * The denominator is the EFFECTIVE window, not raw. Once usage crosses
 * the effective ceiling there is no actual room left for a real reply —
 * any further input just steals from the reserved summary headroom.
 *
 * The numerator is input + output — the true context occupancy. The
 * previous version used only `totalInputTokens`, which understated
 * pressure because the current turn's output tokens occupy the window
 * but aren't yet reflected in `prompt_tokens`.
 */
export function calculateContextPercentages(
  currentUsage: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
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

  const input = totalInputTokens(currentUsage)
  const output = currentUsage.completion_tokens ?? 0
  const total = totalContextTokens(input, output)
  const raw = Math.round((total / effective) * 100)
  const clampedUsed = Math.min(100, Math.max(0, raw))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}