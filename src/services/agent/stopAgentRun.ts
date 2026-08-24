/**
 * stopAgentRun — a ÚNICA implementação de "Stop" do agente.
 *
 * Havia dois botões Stop com semânticas opostas: o da prompt bar limpava a
 * fila inteira (descartando TAREFAS enfileiradas de propósito) e o da status
 * bar não limpava nada (o guard ficava idle e o drain disparava a tarefa
 * seguinte NO INSTANTE do stop — "Stop que não pára"). Este módulo dá aos
 * dois o mesmo contrato:
 *
 *   1. Orientações (steer) são descartadas — eram correcções para o run que
 *      está a morrer; não fazem sentido depois dele.
 *   2. TAREFAS enfileiradas sobrevivem, PARQUEADAS: a fila fica em pausa
 *      (setQueuePaused) e nada corre até o utilizador carregar em Retomar
 *      na strip ou enviar uma nova mensagem.
 *   3. Todo o trabalho vivo morre: sub-agentes, loop principal, prompts de
 *      permissão/credencial/pergunta pendentes, diffs à espera de decisão.
 */

import AgentService from './agentService'
import {
  hasCommandsInQueue,
  removeSteerableMessages,
  setQueuePaused,
} from './messageQueue'
import { resolveAllPendingDiffApprovals, useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSubAgentStore } from '../../stores/subAgentStore'

/**
 * Pára tudo. Devolve false se o utilizador desistiu no confirm de
 * permissões pendentes (nada foi tocado), true caso contrário.
 */
export function stopAgentRun(): boolean {
  // Confirm herdado dos dois handlers antigos: parar com permissões em fila
  // cancela-as todas — o utilizador pode preferir decidi-las primeiro.
  const pendingCount = usePermissionStore.getState().getQueuedCount()
  if (pendingCount > 0) {
    const confirmed = window.confirm(
      `There are ${pendingCount} pending permission${pendingCount > 1 ? 's' : ''} in the queue. ` +
        `Stopping will cancel all of them. Continue?`,
    )
    if (!confirmed) return false
  }

  // Fila PRIMEIRO, e antes do cancel: com o guard ainda ocupado, o
  // useQueueProcessor não pode disparar entre estas duas linhas; quando o
  // cancelLoop o libertar, a pausa já está posta e nada arranca sozinho.
  // Scoping por sessão: só morrem os steers do run que está a parar —
  // itens enfileirados noutra sessão (outro projecto) sobrevivem.
  removeSteerableMessages({
    sessionId: useChatStore.getState().streamingSessionId,
  })
  if (hasCommandsInQueue()) setQueuePaused(true)

  usePermissionStore.getState().clearPending()
  usePermissionStore.getState().resetAutoApprove()
  // Desbloqueia o agente E descarta os diffs à espera de decisão (marca-os como
  // recusados na UI) — sem a segunda parte, os botões Accept/Reject ficavam
  // clicáveis depois do Stop. Ver resolveAllPendingDiffApprovals.
  resolveAllPendingDiffApprovals(false)
  useSubAgentStore.getState().abortAll()
  AgentService.getInstance().cancelLoop()
  useAgentStore.getState().setError(null)
  useAgentStore.getState().setStatus('cancelled')
  useChatStore.getState().finalizeAssistantMessage({ interrupted: true })
  return true
}
