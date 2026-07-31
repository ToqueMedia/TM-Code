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

import { CHARS_PER_TOKEN_ESTIMATE } from '../agentConfig'
import type { ContentBlockAPI } from '../../../types/chat'
import { getCompactUserSummaryMessage } from './prompt'
import {
  getAutoCompactThreshold as getRealAutoCompactThreshold,
  FALLBACK_CONTEXT_WINDOW,
} from '../../../utils/contextWindow'

// ── Constants ──

/** Stop trying autocompact after this many consecutive failures. */
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
/**
 * Arrefecimento do disjuntor.
 *
 * Era um FUSÍVEL, não um disjuntor (auditoria 2026-07-29): `consecutiveFailures`
 * nunca decrescia, portanto três falhas — que num run longo podem ser três
 * blips de rede no sumarizador — desligavam a compactação POR SUMÁRIO para o
 * resto do run. O que sobrava era o snip mecânico: corta o mais antigo sem
 * resumir nada, ou seja, o run passava o resto da vida a perder contexto que
 * um sumário teria guardado.
 *
 * Meio-aberto: passados 90s desde a última falha, deixa passar UMA tentativa.
 * Se falhar, o relógio recomeça; se acertar, as falhas voltam a zero.
 */
const AUTOCOMPACT_BREAKER_COOLDOWN_MS = 90_000

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
  /** Quando a última falha ocorreu — alimenta o arrefecimento do disjuntor. */
  lastFailureAt?: number
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
  /**
   * Quantas mensagens estavam no pedido que produziu `realOccupancyTokens`.
   * É o que permite ancorar: o real cobre esse prefixo, e só as mensagens
   * DEPOIS dele precisam de estimativa. Sem isto, o real e a estimativa
   * medem o mesmo intervalo e a única combinação possível é escolher um.
   */
  realOccupancyMessageCount?: number | null
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

/** Como a ocupação foi resolvida neste turno — vai para a telemetria. */
export type OccupancySource = 'anchored' | 'max-fallback' | 'estimate-only'

/**
 * Ocupação: ÂNCORA no real + estimativa só do que veio depois.
 *
 * PORQUE NÃO É UM `Math.max` (era, até 2026-07-31)
 * ────────────────────────────────────────────────
 * O estimador media caracteres e o real vinha do provider — mas os dois
 * cobriam o MESMO intervalo, portanto a única forma de os combinar era
 * escolher um. Escolhia-se o maior, e como o estimador era estruturalmente
 * alto (`chars/3` contra um rácio real medido de ~4,05) a verdade nunca podia
 * baixar a conta: chegava uma vez por turno e era descartada todas as vezes.
 * A auto-compactação disparava ~30% cedo — o modelo perdia conversa para um
 * resumo com um terço da janela ainda livre.
 *
 * Agora os intervalos são disjuntos: o real cobre as primeiras
 * `realOccupancyMessageCount` mensagens (é literalmente o que o provider
 * contou nesse pedido) e só as acrescentadas depois passam pelo estimador.
 * Somam-se em vez de competirem.
 *
 * O instinto defensivo do `max` (nunca subestimar, senão apanha-se
 * `prompt_too_long`) continua servido: o histórico só cresce, logo o real do
 * turno N−1 é um piso honesto para o turno N; e a rede de recuperação de
 * `prompt_too_long` existe a jusante.
 *
 * `snipTokensFreed` é subtraído no ramo ancorado de propósito: quando o snip
 * forçado liberta tokens, liberta-os da região que o `real` já contabilizou.
 * Hoje é sempre 0 (o snip de rotina saiu), mas o teste em
 * autoCompactLimits.test.ts fixa o comportamento para quando não for.
 */
export function resolveOccupancyWithSource(
  messages: MessageLike[],
  snipTokensFreed: number,
  limits?: AutoCompactLimits,
): { tokens: number; source: OccupancySource } {
  const estimate = Math.max(0, tokenCountWithEstimation(messages) - snipTokensFreed)
  const real = limits?.realOccupancyTokens
  if (typeof real !== 'number' || real <= 0) {
    return { tokens: estimate, source: 'estimate-only' }
  }

  const anchoredAt = limits?.realOccupancyMessageCount
  if (typeof anchoredAt === 'number' && anchoredAt > 0 && anchoredAt <= messages.length) {
    const delta = tokenCountWithEstimation(messages.slice(anchoredAt))
    return { tokens: Math.max(0, real + delta - snipTokensFreed), source: 'anchored' }
  }

  // Âncora inutilizável (primeiro turno, ou o histórico encolheu abaixo do
  // ponto medido). Volta ao comportamento antigo em vez de arriscar um valor
  // baixo de mais — mas a telemetria diz que foi isso que aconteceu, senão
  // uma sessão onde a âncora nunca se aplica é indistinguível de uma onde se
  // aplica sempre.
  return { tokens: Math.max(estimate, real), source: 'max-fallback' }
}

function resolveOccupancy(
  messages: MessageLike[],
  snipTokensFreed: number,
  limits?: AutoCompactLimits,
): number {
  return resolveOccupancyWithSource(messages, snipTokensFreed, limits).tokens
}

/** Minimal message shape for auto-compact. */
interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

// ── Token estimation ──

/**
 * Estimativa de tokens a partir de caracteres. O divisor é MEDIDO e partilhado
 * — ver CHARS_PER_TOKEN_ESTIMATE em agentConfig.ts para os dados e o porquê
 * de ser 3,7 e não 4.
 */
function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
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
        // Imagens contavam ZERO (auditoria 2026-07-28): um primeiro turno
        // multi-imagem não pesava nada na decisão de compactação/bloqueio —
        // e o realOccupancy do provider só cobre do turno 2 em diante.
        // 1600 tokens/imagem é o teto documentado da Anthropic para ~1MP
        // ((w*h)/750); OpenAI high-detail fica abaixo. Sobre-estimar aqui é
        // o lado seguro: compacta cedo em vez de estourar.
        if (block.type === 'image_url') {
          total += 1600
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
  lastFailureAt?: number
}

/**
 * Quantos turnos recentes sobrevivem INTACTOS a uma compactação proativa.
 *
 * PORQUÊ (auditoria 2026-07-28): a compactação substituía o histórico INTEIRO
 * por uma única mensagem de sumário — incluindo os tool results que o modelo
 * acabara de receber e sobre os quais estava a meio de agir. O caminho antigo
 * (contextManager.compressContext) preservava 4-12 turnos recentes; ao migrar
 * para o compact via SDK essa propriedade perdeu-se sem que ninguém notasse,
 * porque compressContext ficou sem callers em vez de ser portado.
 *
 * 3 é o compromisso: chega para o turno em curso e o seu contexto imediato,
 * sem devolver ao prompt o peso que a compactação foi chamada a aliviar.
 */
export const KEEP_RECENT_TURNS_ON_COMPACT = 3

/**
 * Corta o histórico em [antigo | recente] numa fronteira de TURNO.
 *
 * O corte é sempre num `assistant`, nunca a meio de um par tool_call/
 * tool_result: começar num tool result deixaria um resultado órfão, que os
 * providers rejeitam. Se não houver turnos que cheguem, devolve tudo como
 * antigo — compactar sem libertar espaço não serviria de nada.
 */
export function splitForCompaction(
  messages: MessageLike[],
  keepRecentTurns: number,
): { older: MessageLike[]; recent: MessageLike[] } {
  if (keepRecentTurns <= 0) return { older: messages, recent: [] }

  const assistantIndexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') assistantIndexes.push(i)
  }
  if (assistantIndexes.length <= keepRecentTurns) return { older: messages, recent: [] }

  const keepFrom = assistantIndexes[assistantIndexes.length - keepRecentTurns]
  return { older: messages.slice(0, keepFrom), recent: messages.slice(keepFrom) }
}

/**
 * Arquiva o bloco ANTIGO em disco antes de o substituir pelo sumário. Devolve o
 * caminho, ou null quando não há arquivo (falha de escrita, sem projeto/sessão).
 * Best-effort por contrato: nunca deve fazer a compactação falhar.
 */
export type ArchiveOlderFn = (older: MessageLike[]) => Promise<string | null>

/**
 * Summarize the older messages and return [summary, ...recent turns].
 * Returns null when the summarizer produced nothing — the caller decides
 * whether to count a failure or fall back.
 *
 * Shared by the PROACTIVE autoCompact path (below) and the REACTIVE
 * prompt-too-long recovery in query.ts, so both produce the exact same
 * post-compact shape. Kept side-effect-free (no threshold/circuit-breaker
 * logic) so the reactive path can force a compaction it KNOWS is needed
 * (the provider already rejected the prompt).
 *
 * `keepRecentTurns: 0` é o modo de emergência: o caminho reativo já levou um
 * prompt_too_long do provider, portanto liberta tudo o que puder.
 *
 * Nota secundária mas real: só o bloco ANTIGO vai para o sumarizador, o que
 * encolhe o pedido de sumarização — antes ele recebia o histórico completo,
 * já perto do teto, e podia estourar exatamente quando mais fazia falta.
 */
export async function compactNow(
  messages: MessageLike[],
  systemPrompt: string,
  compactFn: CompactFn,
  keepRecentTurns: number = KEEP_RECENT_TURNS_ON_COMPACT,
  archiveOlder?: ArchiveOlderFn,
): Promise<MessageLike[] | null> {
  const { older, recent } = splitForCompaction(messages, keepRecentTurns)

  // O arquivo corre EM PARALELO com a sumarização, não antes: a escrita em
  // disco passa pelo IPC do Tauri e é a operação mais lenta do caminho depois
  // da chamada ao modelo. Serializá-los somava as duas latências a uma pausa
  // que o utilizador vê como "a app pendurou a meio da resposta".
  const archivePromise: Promise<string | null> = archiveOlder
    ? archiveOlder(older).catch(() => null)
    : Promise.resolve(null)

  const summary = await compactFn(older, systemPrompt)
  if (!summary) {
    // Sem sumário não há compactação — o histórico fica como estava e o arquivo
    // ficaria a apontar para mensagens que continuam vivas no contexto. Deixa a
    // escrita terminar (já foi lançada) mas não a referencia.
    void archivePromise
    return null
  }

  const transcriptPath = await archivePromise
  const summaryContent = getCompactUserSummaryMessage(
    summary,
    true,
    recent.length > 0,
    transcriptPath,
  )
  return [{ role: 'user', content: summaryContent }, ...recent]
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
  archiveOlder?: ArchiveOlderFn,
): Promise<AutoCompactResult> {
  // Disjuntor com arrefecimento — ver a nota em AUTOCOMPACT_BREAKER_COOLDOWN_MS.
  const failures = tracking?.consecutiveFailures ?? 0
  if (failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    const openedAt = tracking?.lastFailureAt
    const cooled = openedAt !== undefined && Date.now() - openedAt >= AUTOCOMPACT_BREAKER_COOLDOWN_MS
    if (!cooled) {
      return { wasCompacted: false }
    }
    console.debug(
      '[autoCompact] disjuntor em meio-aberto após arrefecimento — a tentar uma compactação',
    )
  }

  const shouldCompact = shouldAutoCompact(messages, snipTokensFreed, limits)

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const preCompactTokenCount = resolveOccupancy(messages, snipTokensFreed ?? 0, limits)

  try {
    const postCompactMessages = await compactNow(
      messages,
      systemPrompt,
      compactFn,
      KEEP_RECENT_TURNS_ON_COMPACT,
      archiveOlder,
    )

    if (!postCompactMessages) {
      return {
        wasCompacted: false,
        consecutiveFailures: failures + 1,
        lastFailureAt: Date.now(),
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
      // Sucesso limpa o historial: uma tentativa de meio-aberto que acerta
      // devolve o disjuntor a fechado, não a "quase aberto".
      consecutiveFailures: 0,
      lastFailureAt: undefined,
    }
  } catch (error) {
    console.error('[autoCompact] compaction failed:', error)
    const nextFailures = failures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      console.warn(
        `[autoCompact] circuit breaker aberto após ${nextFailures} falhas — nova tentativa dentro de ${AUTOCOMPACT_BREAKER_COOLDOWN_MS / 1000}s`,
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures, lastFailureAt: Date.now() }
  }
}
