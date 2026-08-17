/**
 * Snapshot das entradas EXACTAS do pill de contexto, para o export.
 *
 * PORQUE EXISTE (2026-08-10)
 * ──────────────────────────
 * Reportou-se "o pill mostrou 0% livre e a compactação não disparou". O export
 * tinha tudo o que era preciso para provar que a compactação estava CERTA
 * (pico real 102.361 contra limiar 167.000) e NADA para explicar o 0% — porque
 * o número que o pill lê quando a sessão não traz `lastPromptTokens` é
 * `currentPromptTokens`, um MÁXIMO CORRENTE ao nível do store, que atravessa
 * sessões e nunca é reposto no caminho do Chat. Esse valor não era exportado, e
 * a análise passou a ser por argumento em vez de por medição.
 *
 * O gatilho clássico é trocar a janela publicada (1M → 200K): o limiar cai de
 * ~833.000 para 167.000 e um máximo acumulado na era de 1M passa a excedê-lo,
 * pondo o pill a 0% numa sessão cuja ocupação real está a 60% da folga.
 *
 * Com este bloco no ficheiro, a pergunta fica decidível: se
 * `storeCurrentPromptTokens` for muito maior que `sessionLastPromptTokens`, o
 * pill leu um pico de outra conversa.
 *
 * Usa `getActiveContextWindow` — o mesmo adaptador do auto-compact e do
 * `/context` — para não nascer uma quinta cópia da cadeia de resolução da
 * janela (ver o comentário de `ContextWindowCandidates`).
 */

import type { ChatSession } from '../../types/chat'
import { useChatStore } from '../../stores/chatStore'
import { getActiveContextWindow } from './activeContextWindow'
import { getAutoCompactThreshold, getWarningThreshold } from '../../utils/contextWindow'
import { resolveSessionOccupancy } from '../../utils/sessionOccupancy'

export interface ContextPillState {
  sessionLastPromptTokens: number | null
  sessionLastResponseTokens: number | null
  sessionPeakPromptTokens: number | null
  storeCurrentPromptTokens: number | null
  storeCurrentResponseTokens: number | null
  resolvedContextWindow: number | null
  autoCompactThreshold: number | null
  warningThreshold: number | null
}

export function captureContextPillState(session: ChatSession): ContextPillState {
  const chat = useChatStore.getState()
  const resolved = getActiveContextWindow({
    byokContextWindow: session.byokSnapshot?.contextWindow ?? null,
  })
  const window = resolved.contextWindow > 0 ? resolved.contextWindow : null

  const occ = resolveSessionOccupancy(session)

  return {
    sessionLastPromptTokens: occ.source === 'empty' ? (session.lastPromptTokens ?? null) : occ.promptTokens,
    sessionLastResponseTokens: occ.source === 'empty' ? (session.lastResponseTokens ?? null) : occ.responseTokens,
    sessionPeakPromptTokens: occ.peakTokens > 0 ? occ.peakTokens : null,
    storeCurrentPromptTokens: chat.currentPromptTokens ?? null,
    storeCurrentResponseTokens: chat.currentResponseTokens ?? null,
    resolvedContextWindow: window,
    autoCompactThreshold: window ? getAutoCompactThreshold(window, resolved.maxOutputTokens) : null,
    warningThreshold: window ? getWarningThreshold(window, resolved.maxOutputTokens) : null,
  }
}
