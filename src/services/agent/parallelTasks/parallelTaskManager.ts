/**
 * Dispatcher for user-initiated parallel task agents (v1.0.1 "multi-agent").
 *
 * addParallelTask() enqueues a task; pump() promotes queued tasks to running as
 * long as fewer than MAX_CONCURRENT_TASKS are active, firing the runner for each.
 * The runner calls pump() again when it finishes, so the FIFO queue drains
 * automatically. Everything above the cap simply waits its turn (the user asked
 * for "up to 4 at once, the rest queue").
 */

// NOTA: nada de projectStore aqui — ele arrasta windowService → @tauri-apps
// (rebenta o jsdom dos testes que importam o manager). O projectPath vem da
// sessão ativa do chatStore, que é o mesmo projecto por construção.
import { useParallelTaskStore, MAX_CONCURRENT_TASKS } from '../../../stores/parallelTaskStore'
import { useChatStore } from '../../../stores/chatStore'
import { useBillingStore } from '../../../stores/billingStore'
import { useByokStore } from '../../../stores/byokStore'
import { t } from '../../../i18n'

/** Derive a short card label from the task prompt. */
function deriveDescription(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0].replace(/\s+/g, ' ').trim()
  if (firstLine.length <= 48) return firstLine || 'Task'
  return firstLine.slice(0, 47).trimEnd() + '…'
}

/**
 * Queue a task and kick the pump. Returns the runId. The task starts immediately
 * if a slot is free, otherwise it waits in the FIFO queue.
 *
 * Each task gets its OWN chat session (created non-active so the user's live
 * conversation is untouched): the ProjectMenu lists the task under its project
 * and clicking it opens this session. The prompt is written now; the runner
 * appends the result/error when the task ends.
 */
export function addParallelTask(prompt: string): string | null {
  // Pré-voo de billing (mesmo predicado do gate da fila em useQueueProcessor):
  // sem budget, a tarefa arrancava na mesma e morria no worker com um erro
  // críptico. Recusa à cabeça, com nota visível onde o user escreveu.
  // BYOK herda o funcionamento do main: com chave própria ativa (snapshot da
  // sessão de lançamento), o budget gerido não trava a tarefa — o dispatch do
  // main também não trava (a chave é do user).
  const byokExempt =
    useByokStore.getState().enabled && !!useChatStore.getState().getActiveSession()?.byokSnapshot
  const billing = useBillingStore.getState()
  if (!byokExempt && (billing.noCredits || billing.status === 'rejected')) {
    try {
      useChatStore.getState().addSystemMessage(t('parallel.blockedNoBudget'), 'warn')
    } catch { /* sem chat ativo — nada a anotar */ }
    return null
  }
  const description = deriveDescription(prompt)
  let sessionId: string | undefined
  const chat = useChatStore.getState()
  // A tarefa nasce do composer com um run vivo → há sempre sessão ativa, e o
  // projectPath dela É o projecto atual. Sem sessão (edge), a tarefa corre na
  // mesma — só fica sem transcript clicável.
  const projectPath = chat.getActiveSession()?.projectPath
  // CONTRATO DURO (2026-07-17): sem sessão não há tarefa. O ramo "corre sem
  // transcript clicável" produzia exatamente o pesadelo reportado — uma
  // tarefa visível em memória, inabrível, que desaparecia no primeiro
  // reload sem deixar rasto em disco. Recusa visível > fantasma.
  if (!projectPath) {
    try { chat.addSystemMessage(t('parallel.blockedNoSession'), 'error') } catch { /* sem chat */ }
    return null
  }
  {
    sessionId = chat.createBackgroundSession(projectPath, description)
    chat.appendMessageToSession(sessionId, { role: 'user', content: prompt })
    // Persistência À NASCENÇA: sem isto o chat da tarefa vivia só em memória
    // até ao fim do 1º turno / heartbeat 30s — um reload (HMR em dev!), crash
    // ou abort ainda em fila perdia-o para sempre ("o chat desapareceu da
    // lista", feedback 2026-07-17). Doutrina: só o USER apaga chats de tarefa.
    chat.persistSessionNow(sessionId)
  }
  const id = useParallelTaskStore.getState().createQueued(prompt, description, sessionId, projectPath)
  pumpParallelTasks()
  return id
}

/**
 * Run de CONTINUAÇÃO — "o agente da sessão que estás a ver" (doutrina
 * sem-deus): corre o prompt SOBRE uma sessão existente, com o histórico dela,
 * enquanto o run interativo está ocupado noutra sessão. Não cria sessão nem
 * mexe na fila do main. Devolve o runId, ou null se recusado (billing).
 */
export function addSessionAgentRun(sessionId: string, prompt: string): string | null {
  const chat = useChatStore.getState()
  const session = chat.sessions.get(sessionId)
  if (!session) return null
  // Mesmo pré-voo de billing do addParallelTask; BYOK da SESSÃO ALVA isenta.
  const byokExempt = useByokStore.getState().enabled && !!session.byokSnapshot
  const billing = useBillingStore.getState()
  if (!byokExempt && (billing.noCredits || billing.status === 'rejected')) {
    try { chat.addSystemMessage(t('parallel.blockedNoBudget'), 'warn') } catch { /* sem chat */ }
    return null
  }
  // A bolha do user entra JÁ na sessão (o runner exclui-a do histórico que
  // envia — o submitMessage re-acrescenta o prompt como user message).
  chat.appendMessageToSession(sessionId, { role: 'user', content: prompt })
  chat.persistSessionNow(sessionId)
  const id = useParallelTaskStore
    .getState()
    .createQueued(prompt, deriveDescription(prompt), sessionId, session.projectPath, { continuation: true })
  pumpParallelTasks()
  return id
}

let pumping = false

/**
 * Promote queued tasks to running until the concurrency cap is hit. Re-entrancy
 * guarded (the runner calls this from its terminal handler, which can overlap a
 * fresh addParallelTask). Fire-and-forget: the runner owns each task's lifecycle.
 */
export function pumpParallelTasks(): void {
  if (pumping) return
  pumping = true
  try {
    const store = useParallelTaskStore.getState()
    while (store.runningCount() < MAX_CONCURRENT_TASKS) {
      const nextId = store.nextQueuedId()
      if (!nextId) break
      store.markRunning(nextId)
      // Lazy import breaks the manager↔runner cycle; the runner re-enters pump()
      // on completion to drain the rest of the queue. The .catch is load-bearing:
      // a module-load failure OR an unexpected throw in the runner's setup (before
      // its own try/finally) would otherwise leave the task stuck 'running' and
      // leak its slot forever. Error it and keep draining.
      const id = nextId
      void import('./parallelTaskRunner')
        .then(({ runParallelTask }) => runParallelTask(id))
        .catch((err) => {
          useParallelTaskStore.getState().error(id, err instanceof Error ? err.message : String(err))
          pumpParallelTasks()
        })
    }
  } finally {
    pumping = false
  }
}

/** Stop every parallel task (queued + running). Used by the global Stop-all. */
export function stopAllParallelTasks(): void {
  useParallelTaskStore.getState().abortAll()
}
