/**
 * Paragem GLOBAL quando o orçamento de tokens esgota.
 *
 * O enforcement é do worker (fonte única — billing.ts): um pedido acima do
 * tecto leva 402 `tm_budget_exhausted`/`tm_team_slice_exhausted`. Mas o 402
 * só mata o run cujo pedido foi rejeitado — os OUTROS (sub-agentes em
 * paralelo, próximas mensagens em fila) continuavam até cada um falhar
 * sozinho, queimando um turno extra cada. Este watcher fecha esse buraco:
 *
 *   noCredits flip (false→true) no billingStore  →  aborta TUDO nesta janela
 *   + mensagem de sistema descritiva na sessão + badge cross-janela "error"
 *   com o motivo (via projectAgentStatusService.markNextStopAsBudgetStop).
 *
 * O flip chega por três caminhos, todos já existentes no billingStore:
 *   1. o próprio 402 (query.ts chama setNoCredits),
 *   2. headers `X-Budget-Status: rejected` de uma resposta admitida,
 *   3. /v1/me no focus da janela (é assim que uma janela paralela descobre
 *      que outra janela esgotou o orçamento — não há push do servidor).
 *
 * Fila: as orientações (steer) são descartadas — pertenciam ao run que está
 * a morrer. As TAREFAS sobrevivem PARQUEADAS: a fila fica em pausa
 * (setQueuePaused) e o useQueueProcessor também tem um gate de billing, por
 * isso nada é despachado (nem queima 402s) enquanto não houver consumo; após
 * a compra, o utilizador retoma pela strip ou enviando uma mensagem.
 */

import { useBillingStore } from '@/stores/billingStore'
import { useChatStore } from '@/stores/chatStore'
import {
  hasCommandsInQueue,
  removeSteerableMessages,
  setQueuePaused,
} from '@/services/agent/messageQueue'
import { logger } from '@/utils/logger'
import { t } from '@/i18n'

let started = false
/** True depois de tratar um episódio; reposto quando noCredits volta a false
 *  (compra/reset) para o episódio seguinte contar de novo. */
let handledExhaustion = false

async function stopAllAgentWork(): Promise<void> {
  try {
    const [{ default: agentServiceModule }, { useSubAgentStore }, statusService] =
      await Promise.all([
        import('@/services/agent/agentService'),
        import('@/stores/subAgentStore'),
        import('@/services/projectAgentStatusService'),
      ])
    const agentService = agentServiceModule.getInstance()
    const subAgents = useSubAgentStore.getState()

    // Fila primeiro e SEMPRE (mesmo sem run vivo — o 402 pode ter chegado
    // quando o run principal já ia a terminar): orientações fora, tarefas
    // parqueadas. O gate de billing do processor já as segura; a pausa
    // torna o estado visível (banner + Retomar na strip).
    removeSteerableMessages()
    if (hasCommandsInQueue()) setQueuePaused(true)

    const busy = agentService.isAgentRunning() || subAgents.getPendingCount() > 0
    if (!busy) return

    // Badge primeiro: o cancel abaixo dispara busy→not-busy no
    // projectAgentStatusService, que sem esta marca escreveria "idle"
    // (desaparecimento silencioso nas outras janelas) em vez de "error"
    // com o motivo.
    statusService.markNextStopAsBudgetStop(t('billing.budgetStopBadge'))

    // Mesmo par do botão Stop (stopAgentRun): sub-agentes + loop principal.
    subAgents.abortAll()
    agentService.cancelLoop()

    useChatStore
      .getState()
      .addSystemMessage(
        `${t('chat.noCredits')}: ${t('billing.budgetStopMessage')} ${t('chat.buyCredits')}.`,
        'error',
      )
  } catch (e) {
    logger.warn('agent', 'Budget-stop failed to cancel agent work:', e)
  }
}

/** Idempotente — chamado uma vez no arranque da app (App.tsx). */
export function initBudgetStopWatcher(): void {
  if (started) return
  started = true

  useBillingStore.subscribe((state, prev) => {
    if (state.noCredits && !prev.noCredits && !handledExhaustion) {
      handledExhaustion = true
      void stopAllAgentWork()
    }
    if (!state.noCredits && prev.noCredits) {
      handledExhaustion = false
    }
  })
}
