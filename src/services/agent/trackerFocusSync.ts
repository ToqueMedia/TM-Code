/**
 * TRACKER POR-SESSÃO — sincronização do FOCO (sem-deus, 2026-07-18).
 *
 * Invariante: o tracker espelhado em `agentStore.tasks` (o que a UI mostra)
 * segue SEMPRE a sessão de chat ativa. Quando o user troca de sessão (ou abre
 * o chat de uma tarefa paralela), o painel passa a mostrar o tracker DESSA
 * sessão — cada sessão tem o seu, o "main" não é especial.
 *
 * Um único subscribe ao chatStore reage à mudança de activeSessionId:
 *   1. foca o tracker da nova sessão (espelho imediato do que já está em memória);
 *   2. hidrata do disco (tasks-<sid>.json) se o balde ainda estiver vazio,
 *      com guarda "latest-wins" (troca rápida de sessões não aplica um load
 *      obsoleto por cima do atual).
 *
 * Idempotente — chamar startTrackerFocusSync() as vezes que forem precisas.
 */
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { loadTasksForSession } from './taskPersistence'

let started = false

export async function reconcileTrackerFocus(sessionId: string | null): Promise<void> {
  return reconcile(sessionId)
}

async function reconcile(sessionId: string | null): Promise<void> {
  const agent = useAgentStore.getState()
  // Foca já — o espelho mostra o que houver em memória para esta sessão.
  agent.focusTrackerSession(sessionId)
  if (!sessionId) return
  // Só hidrata quando o balde está vazio (ainda não carregado neste processo);
  // um tracker já vivo em memória é mais recente que o disco.
  if (agent.getTasksForSession(sessionId).length > 0) return
  const projectPath = useProjectStore.getState().currentProject?.path
  if (!projectPath) return
  try {
    const loaded = await loadTasksForSession(projectPath, sessionId)
    if (loaded.length === 0) return
    const now = useAgentStore.getState()
    // Latest-wins: só aplica se ESTA sessão continua focada e o balde continua
    // vazio (evita pisar um update_tasks que entrou durante o load async).
    if (now.focusedTrackerSessionId === sessionId && now.getTasksForSession(sessionId).length === 0) {
      now.setTasksForSession(sessionId, loaded)
    }
  } catch {
    /* hidratação é best-effort — a sessão começa com tracker vazio */
  }
}

export function startTrackerFocusSync(): void {
  if (started) return
  started = true
  // Estado inicial (sessão já ativa quando isto arranca).
  void reconcile(useChatStore.getState().activeSessionId)
  // Reage só à MUDANÇA de sessão ativa (o subscribe dispara em qualquer set;
  // o guard de igualdade evita trabalho durante o streaming).
  useChatStore.subscribe((state, prev) => {
    if (state.activeSessionId !== prev.activeSessionId) {
      void reconcile(state.activeSessionId)
    }
  })
}
