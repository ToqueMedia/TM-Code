/**
 * Ocupação de contexto JÁ TRABALHADA numa sessão — o que o pill deve
 * mostrar ao reabrir um projecto, sem esperar pelo próximo turno.
 *
 * PORQUÊ (2026-08-14)
 * ───────────────────
 * O círculo só lia `session.lastPromptTokens`. Esse campo NÃO é gravado no
 * JSON da sessão: a ocupação real vive em `lastTurnSnapshot` e no
 * `requestUsageLog`. O load copiava o snapshot para `lastPromptTokens` em
 * alguns caminhos, noutros não — e `lastPromptTokens: 0` (createSession /
 * reset) era tratado como valor autoritativo. Resultado: abrir o zAi com
 * 128 613 tokens no disco mostrava "Ainda sem pedido nesta sessão".
 *
 * Ordem (nunca o `currentPromptTokens` do store — esse atravessa sessões):
 *   1. 0 explícito DEPOIS de compactar (há compact_boundary)
 *   2. lastPromptTokens só se veio de usage REAL e não está envenenado
 *      (405k de estimativa com lastPromptFromUsage flipado no load)
 *   3. último pedido REAL do requestUsageLog
 *   4. lastTurnSnapshot.promptTokens > 0
 *   5. lastPromptTokens > 0 (estimativa, só sem usage real)
 *   6. estimativa por caracteres das mensagens
 *   7. vazio
 *
 * O passo 2/3 existiam invertidos: lastPromptTokens > 0 ganhava sempre, e
 * o export 14-49-57 reabria com 405 674 / 242 144 (vermelho, “próximo
 * turno compacta”) enquanto o provider nunca passou de 145 608.
 */

import type { ChatMessage, ChatSession, RequestUsageEntry, SessionTurnSnapshot } from '../types/chat'

export type OccupancySource =
  | 'lastPromptTokens'
  | 'lastTurnSnapshot'
  | 'requestUsageLog'
  | 'estimate'
  | 'compacted'
  | 'empty'

export interface SessionOccupancy {
  promptTokens: number
  responseTokens: number
  peakTokens: number
  source: OccupancySource
}

export interface SessionOccupancyInput {
  lastPromptTokens?: number
  lastResponseTokens?: number
  lastPromptFromUsage?: boolean
  peakPromptTokens?: number
  lastTurnSnapshot?: SessionTurnSnapshot | null
  requestUsageLog?: RequestUsageEntry[]
  messages?: Pick<ChatMessage, 'kind' | 'content' | 'contentBlocks'>[]
}

/**
 * Semente do medidor do loop: o mesmo prato, não uma refeição nova.
 *
 * "continue" (ou qualquer follow-up depois de um Stop) é uma MENSAGEM, não
 * um comando. O query() seguinte é outra invocação, mas a conversa é a
 * mesma — no cli-vaz o shouldAutoCompact conta esse mesmo `messages`. Sem
 * semente, o TM Code punha lastTurnRealOccupancy a undefined e o primeiro
 * pedido media o prato outra vez (ou pior: com o campo 405k da estimativa).
 */
export interface QueryOccupancySeed {
  /** prompt + completion do último pedido REAL (o lastTurnRealOccupancy). */
  tokens: number
  /**
   * Mensagens que esse real já cobre (`totalMessages` do pedido).
   * null = o motor usa o comprimento do histórico (o prato antes do follow-up).
   */
  messageCount: number | null
}

function lastRealUsage(log: RequestUsageEntry[] | undefined): {
  input: number
  output: number
  totalMessages: number | null
  peak: number
} | null {
  if (!log || log.length === 0) return null
  let last: { input: number; output: number; totalMessages: number | null } | null = null
  let peak = 0
  for (let i = 0; i < log.length; i++) {
    const entry = log[i]
    if (entry.usageAvailable === false) continue
    const input = typeof entry.inputTokens === 'number' ? entry.inputTokens : 0
    if (input <= 0) continue
    const output = typeof entry.outputTokens === 'number' ? entry.outputTokens : 0
    const totalMessages =
      typeof entry.totalMessages === 'number' && entry.totalMessages > 0
        ? entry.totalMessages
        : null
    last = { input, output, totalMessages }
    if (input > peak) peak = input
  }
  return last ? { ...last, peak } : null
}

/** Estimativa / pico vazado: 405k contra um real de 146k. Folga 1.5×. */
function occupancyLooksPoisoned(claimed: number, realPeak: number): boolean {
  if (realPeak <= 0 || claimed <= 0) return false
  return claimed > realPeak * 1.5
}

function sessionWasCompacted(session: SessionOccupancyInput): boolean {
  return (session.messages ?? []).some((m) => m.kind === 'compact_boundary')
}

/**
 * Ocupação REAL para o primeiro shouldAutoCompact de um query() novo.
 * Nunca devolve a estimativa por caracteres — esse era o 405k que pintava
 * o pill a vermelho enquanto o provider tinha ~146k.
 */
export function resolveQueryOccupancySeed(
  session: SessionOccupancyInput | null | undefined,
): QueryOccupancySeed | null {
  if (!session) return null

  const live = session.lastPromptTokens
  const snap = session.lastTurnSnapshot
  if (sessionWasCompacted(session) && (live === 0 || snap?.promptTokens === 0)) {
    return null
  }

  const realLog = lastRealUsage(session.requestUsageLog)
  if (realLog) {
    return {
      tokens: realLog.input + realLog.output,
      messageCount: realLog.totalMessages,
    }
  }

  if (session.lastPromptFromUsage === true && typeof live === 'number' && live > 0) {
    return {
      tokens: live + (session.lastResponseTokens ?? 0),
      messageCount: null,
    }
  }

  if (snap && snap.promptTokens > 0) {
    return {
      tokens: snap.promptTokens + (snap.responseTokens ?? 0),
      messageCount: null,
    }
  }

  return null
}

/**
 * Quantas mensagens do pedido novo já estão cobertas pela semente.
 * Se o `totalMessages` persistido ainda cabe no histórico, usa-o (delta =
 * o que cresceu desde o último pedido, incluindo o follow-up). Senão o
 * prato inteiro já foi medido — só a mensagem nova é estimativa.
 */
export function resolveSeedMessageCount(
  seedCount: number | null | undefined,
  historyLength: number,
): number | undefined {
  if (historyLength <= 0) return undefined
  if (typeof seedCount === 'number' && seedCount > 0 && seedCount <= historyLength) {
    return seedCount
  }
  return historyLength
}

export function estimateTokensFromMessages(
  messages: SessionOccupancyInput['messages'] | undefined,
): number {
  if (!messages || messages.length === 0) return 0
  let totalChars = 0
  for (const msg of messages) {
    const content: unknown = msg.content
    if (typeof content === 'string') {
      totalChars += content.length
    } else if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; text?: string }>) {
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          totalChars += part.text.length
        }
      }
    }
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'text' || block.type === 'reasoning') {
          totalChars += block.text.length
        }
      }
    }
  }
  return Math.round(totalChars / 4)
}

export function resolveSessionOccupancy(session: SessionOccupancyInput | null | undefined): SessionOccupancy {
  if (!session) {
    return { promptTokens: 0, responseTokens: 0, peakTokens: 0, source: 'empty' }
  }

  const live = session.lastPromptTokens
  const liveResponse = session.lastResponseTokens ?? 0
  const snap = session.lastTurnSnapshot
  const compacted = (session.messages ?? []).some((m) => m.kind === 'compact_boundary')
  const realLog = lastRealUsage(session.requestUsageLog)

  // 0 depois de compactar é ocupação real da conversa nova — o log ainda
  // tem os pedidos pré-corte e não pode ressuscitá-los no pill.
  if (compacted && (live === 0 || snap?.promptTokens === 0)) {
    return { promptTokens: 0, responseTokens: 0, peakTokens: 0, source: 'compacted' }
  }

  const liveIsReal = session.lastPromptFromUsage === true && typeof live === 'number' && live > 0
  const livePoisoned = liveIsReal && realLog
    ? occupancyLooksPoisoned(live, realLog.peak)
    : false

  if (liveIsReal && !livePoisoned) {
    return {
      promptTokens: live,
      responseTokens: liveResponse,
      peakTokens: Math.max(realLog?.peak ?? 0, live),
      source: 'lastPromptTokens',
    }
  }

  if (realLog) {
    return {
      promptTokens: realLog.input,
      responseTokens: realLog.output,
      peakTokens: realLog.peak,
      source: 'requestUsageLog',
    }
  }

  if (snap && snap.promptTokens > 0) {
    return {
      promptTokens: snap.promptTokens,
      responseTokens: snap.responseTokens ?? 0,
      peakTokens: Math.max(snap.peakPromptTokens ?? 0, snap.promptTokens),
      source: 'lastTurnSnapshot',
    }
  }

  if (typeof live === 'number' && live > 0) {
    return {
      promptTokens: live,
      responseTokens: liveResponse,
      peakTokens: Math.max(session.peakPromptTokens ?? 0, snap?.peakPromptTokens ?? 0, live),
      source: 'lastPromptTokens',
    }
  }

  const estimate = estimateTokensFromMessages(session.messages)
  if (estimate > 0) {
    return {
      promptTokens: estimate,
      responseTokens: 0,
      peakTokens: Math.max(session.peakPromptTokens ?? 0, estimate),
      source: 'estimate',
    }
  }

  return { promptTokens: 0, responseTokens: 0, peakTokens: 0, source: 'empty' }
}

/** Grava a ocupação resolvida nos campos que o pill e o persist lêem. */
export function withResolvedOccupancy<T extends ChatSession>(session: T): T {
  const occ = resolveSessionOccupancy(session)
  return {
    ...session,
    lastPromptTokens: occ.promptTokens,
    lastResponseTokens: occ.responseTokens,
    peakPromptTokens: occ.peakTokens,
    lastPromptFromUsage: occ.source === 'lastPromptTokens'
      || occ.source === 'lastTurnSnapshot'
      || occ.source === 'requestUsageLog'
      || occ.source === 'compacted',
  }
}
