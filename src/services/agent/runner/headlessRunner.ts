/**
 * Runner headless (P5 — docs/DESIGN-HEADLESS-RUNNER.md, 2026-08-03).
 *
 * Arranca quando o processo foi lançado com `--run "<tarefa>" --project <dir>
 * [--yolo]` (ou TM_RUN_TASK/TM_RUN_PROJECT/TM_RUN_YOLO=1 no dev). A app monta
 * NORMALMENTE numa janela invisível (decisão janela-oculta do design: o IPC
 * Tauri e o ambiente de renderer ficam intactos); este serviço apenas:
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
 * TODO o corpo corre dentro de um try/catch que emite o erro como NDJSON e
 * sai com código 1 — o smoke #3 de 03-08 provou que uma rejeição muda
 * (import dinâmico a falhar depois do project_open) desaparecia no
 * .catch(() => {}) do main.tsx e o processo ficava pendurado em silêncio.
 * Num runner, silêncio é o único erro imperdoável.
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

  try {
    await runJob(job)
  } catch (err) {
    emit({
      type: 'result',
      subtype: 'error',
      error: String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
    })
    exit(1)
  }
  return true
}

async function runJob(job: RunnerJob): Promise<void> {
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
      return
    }
    await new Promise(r => setTimeout(r, 250))
  }
  emit({
    type: 'system',
    subtype: 'project_open',
    path: useProjectStore.getState().currentProject?.path,
  })

  // Imports do condutor TODOS antes do enqueue — se algum falhar, o erro
  // sai pelo try/catch do caller em vez de deixar um job órfão na fila.
  const {
    enqueue,
    getCommandQueueSnapshot,
    isQueuePaused,
    setQueuePaused,
  } = await import('../messageQueue')
  const { useAgentStore } = await import('@/stores/agentStore')
  const { useChatStore } = await import('@/stores/chatStore')
  const { getQueryGuard } = await import('../queryGuard')
  const { useBillingStore } = await import('@/stores/billingStore')

  let sawActive = false
  let finished = false
  let unsubscribe: () => void = () => {}
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const finish = (code: number, payload: Record<string, unknown>) => {
    if (finished) return
    finished = true
    unsubscribe()
    if (hardTimer) clearTimeout(hardTimer)
    if (heartbeat) clearInterval(heartbeat)
    emit(payload)
    exit(code)
  }

  // 4. Fim do run: idle DEPOIS de ter estado activo. Subscrito ANTES do
  // enqueue para não haver janela em que o run começa e acaba sem nós.
  unsubscribe = useAgentStore.subscribe((state) => {
    // 'error' é TERMINAL (smoke P6 #5: o status encravou em error e o
    // condutor, que só conhecia idle, ficou pendurado até ao hard timeout
    // sem nunca reportar o erro). Emite o erro do store + a cauda da última
    // mensagem da sessão — o diagnóstico que a janela mostraria.
    if (state.status === 'error') {
      if (finished) return
      let lastMessage = ''
      try {
        const session = useChatStore.getState().getActiveSession()
        const last = [...(session?.messages ?? [])].reverse()[0]
        lastMessage =
          typeof last?.content === 'string'
            ? last.content.slice(-2000)
            : JSON.stringify(last?.content ?? '').slice(-2000)
      } catch {
        /* diagnóstico é melhor-esforço */
      }
      finish(1, {
        type: 'result',
        subtype: 'error',
        error: state.error ?? 'agent status = error (sem mensagem no store)',
        lastMessage,
      })
      return
    }
    if (state.status !== 'idle') {
      sawActive = true
      return
    }
    if (!sawActive || finished) return
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

  hardTimer = setTimeout(() => {
    finish(1, {
      type: 'result',
      subtype: 'error',
      error: `hard timeout after ${HARD_TIMEOUT_MS / 60_000} minutes`,
    })
  }, HARD_TIMEOUT_MS)

  // Diagnóstico até o run arrancar (smoke P6: os portões da drenagem do
  // useQueueProcessor eram invisíveis de fora). E uma fila PAUSADA não pode
  // reter o job: a rehidratação do snapshot persistido pausa a fila quando
  // traz tarefas parqueadas — numa janela oculta isso é estado de uma
  // sessão antiga, não uma decisão do operador; o runner retoma e regista.
  heartbeat = setInterval(() => {
    // Bate também DURANTE o run (smoke P6: o silêncio pós-arranque era
    // indistinguível de um encravamento) — só o finish o cala.
    if (finished) return
    if (isQueuePaused()) {
      emit({ type: 'system', subtype: 'queue_resumed', note: 'persisted pause overridden by runner' })
      setQueuePaused(false)
    }
    const billing = useBillingStore.getState()
    emit({
      type: 'system',
      subtype: 'heartbeat',
      elapsedSec: Math.round((Date.now() - startAt) / 1000),
      queue: getCommandQueueSnapshot().length,
      queuePaused: isQueuePaused(),
      agentStatus: useAgentStore.getState().status,
      queryActive: getQueryGuard().getSnapshot(),
      billingStatus: billing.status,
      noCredits: billing.noCredits,
    })
  }, 3000)

  // 3. Tarefa pelo caminho normal da fila — por último, com tudo armado.
  enqueue({ value: job.task, mode: 'prompt' })
  emit({ type: 'system', subtype: 'enqueued', queue: getCommandQueueSnapshot().length })
}
