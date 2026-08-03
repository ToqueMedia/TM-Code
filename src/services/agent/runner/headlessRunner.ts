/**
 * Runner headless (P5 — docs/DESIGN-HEADLESS-RUNNER.md, 2026-08-03).
 *
 * Arranca quando o processo foi lançado com `--run "<tarefa>" --project <dir>
 * [--yolo]`. A app monta NORMALMENTE numa janela invisível (decisão
 * janela-oculta do design: o IPC Tauri e o ambiente de renderer ficam
 * intactos); este serviço apenas:
 *
 *  1. instala o hospedeiro headless no registry (setAgentHost) ANTES de
 *     qualquer run — todas as decisões humanas passam a política imediata;
 *  2. espera o boot normal abrir o projecto (o --project entrou pelo slot
 *     pending_open_project do Rust — o caminho de sempre);
 *  3. enfileira a tarefa no caminho NORMAL (messageQueue.enqueue → o
 *     useQueueProcessor do PromptBar drena quando o agente está idle) — o
 *     runner não duplica o pipeline de dispatch;
 *  4. detecta o fim do run (status volta a 'idle' depois de ter saído dele),
 *     emite o resultado como NDJSON via runner_emit e termina o processo.
 *
 * v1 deliberadamente fino: init/project_open/result + backstop de wall-clock.
 * Streaming de deltas e usage por pedido são o passo seguinte (o hostBus já
 * transporta progresso de tools; basta subscrever e reencaminhar).
 */

import { invoke } from '@/utils/invokeMetrics'
import { setAgentHost } from '../host/agentHost'
import { createHeadlessAgentHost } from '../host/headlessHost'

interface RunnerJob {
  task: string
  project: string
  yolo: boolean
}

const HARD_TIMEOUT_MS = 30 * 60_000
const PROJECT_OPEN_TIMEOUT_MS = 60_000

function emit(obj: Record<string, unknown>): void {
  void invoke('runner_emit', { line: JSON.stringify(obj) }).catch(() => {
    /* stdout indisponível não pode matar o run */
  })
}

function exit(code: number): void {
  void invoke('runner_exit', { code }).catch(() => {
    /* sem saída limpa, o hard timeout do caller encarrega-se */
  })
}

/** True se o processo está em modo runner (job presente) — nesse caso o
 *  condutor fica activo até ao runner_exit. */
export async function maybeStartHeadlessRunner(): Promise<boolean> {
  let job: RunnerJob | null = null
  try {
    job = await invoke<RunnerJob | null>('runner_get_job')
  } catch {
    // Fora do Tauri (jest/browser puro): não há runner.
    return false
  }
  if (!job || !job.task) return false

  // ANTES de qualquer run: o hospedeiro headless responde por política.
  setAgentHost(createHeadlessAgentHost({ yolo: job.yolo }))
  emit({ type: 'system', subtype: 'init', project: job.project, yolo: job.yolo })

  const startAt = Date.now()

  // 2. Espera o boot normal abrir o projecto.
  const { useProjectStore } = await import('@/stores/projectStore')
  while (!useProjectStore.getState().currentProject?.path) {
    if (Date.now() - startAt > PROJECT_OPEN_TIMEOUT_MS) {
      emit({
        type: 'result',
        subtype: 'error',
        error: `project did not open within ${PROJECT_OPEN_TIMEOUT_MS / 1000}s — is --project a valid directory?`,
      })
      exit(1)
      return true
    }
    await new Promise(r => setTimeout(r, 250))
  }
  emit({
    type: 'system',
    subtype: 'project_open',
    path: useProjectStore.getState().currentProject?.path,
  })

  // 3. Tarefa pelo caminho normal da fila.
  const {
    enqueue,
    getCommandQueueSnapshot,
    isQueuePaused,
    setQueuePaused,
  } = await import('../messageQueue')
  enqueue({ value: job.task, mode: 'prompt' })

  // 4. Fim do run: idle DEPOIS de ter estado activo.
  const { useAgentStore } = await import('@/stores/agentStore')
  const { useChatStore } = await import('@/stores/chatStore')
  let sawActive = false
  let finished = false

  const finish = (code: number, payload: Record<string, unknown>) => {
    if (finished) return
    finished = true
    unsubscribe()
    clearTimeout(hardTimer)
    clearInterval(heartbeat)
    emit(payload)
    exit(code)
  }

  // Diagnóstico até o run arrancar (smoke P6 de 03-08: init+project_open
  // chegaram e depois silêncio — os portões da drenagem eram invisíveis).
  // Cada batimento emite o estado dos QUATRO portões do useQueueProcessor;
  // e uma fila PAUSADA não pode reter o job do runner: a rehidratação do
  // snapshot persistido do projecto pausa a fila quando traz tarefas
  // parqueadas (messageQueue.hydrateCommandQueue) — em modo runner isso é
  // estado de uma sessão de janela antiga, não uma decisão do operador.
  const { getQueryGuard } = await import('../queryGuard')
  const { useBillingStore } = await import('@/stores/billingStore')
  const heartbeat = setInterval(() => {
    if (finished || sawActive) return
    if (isQueuePaused()) {
      emit({ type: 'system', subtype: 'queue_resumed', note: 'persisted pause overridden by runner' })
      setQueuePaused(false)
    }
    const billing = useBillingStore.getState()
    emit({
      type: 'system',
      subtype: 'heartbeat',
      queue: getCommandQueueSnapshot().length,
      queuePaused: isQueuePaused(),
      agentStatus: useAgentStore.getState().status,
      queryActive: getQueryGuard().getSnapshot(),
      billingStatus: billing.status,
      noCredits: billing.noCredits,
    })
  }, 3000)

  const unsubscribe = useAgentStore.subscribe((state) => {
    if (state.status !== 'idle') {
      sawActive = true
      return
    }
    if (!sawActive || finished) return
    // Último texto do assistant da sessão activa — o "result" do run.
    try {
      const session = useChatStore.getState().getActiveSession()
      const last = [...(session?.messages ?? [])]
        .reverse()
        .find(m => m.role === 'assistant')
      const text =
        typeof last?.content === 'string'
          ? last.content
          : JSON.stringify(last?.content ?? '')
      finish(0, { type: 'result', subtype: 'success', text })
    } catch (err) {
      finish(1, { type: 'result', subtype: 'error', error: String(err) })
    }
  })

  const hardTimer = setTimeout(() => {
    finish(1, {
      type: 'result',
      subtype: 'error',
      error: `hard timeout after ${HARD_TIMEOUT_MS / 60_000} minutes`,
    })
  }, HARD_TIMEOUT_MS)

  return true
}
