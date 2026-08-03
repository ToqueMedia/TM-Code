import { getQueryGuard } from '../services/agent/queryGuard'
import { useParallelTaskStore } from '../stores/parallelTaskStore'

/**
 * Leitura IMPERATIVA de "o agente está a trabalhar".
 *
 * MESMA composição que o composer subscreve reativamente
 * (`usePromptBar`: QueryGuard OU project-runs vivos → `PromptActions`
 * `isAgentBusy={isAgentBusy || anyLiveTask}`). Existe para que handlers fora
 * do React — atalhos de teclado, menus — que bloqueiam as mesmas ações não
 * divirjam do que a UI mostra desativado: um botão cinzento com um atalho
 * que continua a funcionar é pior do que não bloquear nada.
 *
 * O QueryGuard cobre o run principal ao nível do dispatch (não só o
 * streaming de tokens), por isso a preparação de um run — token, system
 * prompt, planner — já conta como ocupado.
 */
export function isAgentBusyNow(): boolean {
  if (getQueryGuard().getSnapshot()) return true
  for (const run of useParallelTaskStore.getState().runs.values()) {
    if (run.status === 'running' || run.status === 'queued') return true
  }
  return false
}
