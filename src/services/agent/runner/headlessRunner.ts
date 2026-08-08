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
  // Persona determinística (ronda-2 #11): sem isto o runner herdava do
  // localStorage a última persona escolhida na GUI — um eval era servido e
  // faturado conforme o humor da janela. Headless corre SEMPRE na standard
  // (a base do sistema); quando fizer falta por-job, o RunnerJob ganha campo.
  const { usePersonaStore } = await import('../../../stores/personaStore')
  usePersonaStore.getState().setSelected('standard')
  // Com --yolo, liga TAMBÉM o YOLO do permissionStore: é o interruptor que
  // faz o createDiffApprovalPromise APLICAR os diffs ao disco pelo caminho
  // provado da janela (DiffService.acceptDiff, com a honestidade de escrita
  // falhada ≠ aprovação). Sem isto, o eval write-file mostrou o modelo a
  // anunciar "ficheiro criado" com o disco intacto — o diff ficava pendente
  // para sempre.
  if (job.yolo) {
    try {
      const { usePermissionStore } = await import('@/stores/permissionStore')
      usePermissionStore.getState().setAutoModePermissions(true)
    } catch {
      /* sem store não há YOLO para ligar */
    }
  }
  emit({ type: 'system', subtype: 'init', project: job.project, yolo: job.yolo })

  // Rota activa — diagnóstico do smoke #7: "Connection error (Load failed)"
  // era o VITE_AI_WORKER_URL do .env local a apontar ao worker de dev
  // (localhost:8788) sem `yarn tauri:dev:all` a corrê-lo. Com a rota no
  // NDJSON, esse desalinhamento lê-se na primeira linha em vez de se
  // deduzir à sétima iteração.
  let aiWorkerUrl: string | null = null
  let byokEnabled = false
  try {
    const [{ useByokStore }, { resolveAIWorkerUrl }] = await Promise.all([
      import('@/stores/byokStore'),
      import('@/utils/devUrls'),
    ])
    byokEnabled = useByokStore.getState().enabled
    aiWorkerUrl = resolveAIWorkerUrl()
    emit({
      type: 'system',
      subtype: 'route',
      byokEnabled,
      aiWorkerUrl,
    })
  } catch {
    /* diagnóstico é melhor-esforço */
  }

  // Preflight da rota gerida (smoke #8: com o VITE_AI_WORKER_URL local e o
  // wrangler ainda a arrancar — ou nem lançado — o primeiro request morria
  // em "Load failed" e o run inteiro ia ao chão por uma corrida de boot).
  // Qualquer resposta HTTP prova que há alguém a ouvir (o 404 tm_not_found
  // do worker serve); sem resposta em 30s o run nem arranca e o erro diz
  // exactamente o que falta. BYOK directo não passa pelo worker — salta.
  if (aiWorkerUrl && !byokEnabled) {
    const ROUTE_PREFLIGHT_TIMEOUT_MS = 30_000
    const preflightStart = Date.now()
    let reachable = false
    while (Date.now() - preflightStart < ROUTE_PREFLIGHT_TIMEOUT_MS) {
      try {
        await fetch(aiWorkerUrl, { method: 'GET', mode: 'cors' })
        reachable = true
        break
      } catch {
        await new Promise(r => setTimeout(r, 500))
      }
    }
    if (!reachable) {
      emit({
        type: 'result',
        subtype: 'error',
        error:
          `AI route unreachable at ${aiWorkerUrl} after ${ROUTE_PREFLIGHT_TIMEOUT_MS / 1000}s — ` +
          `em dev com worker local (VITE_AI_WORKER_URL), arranca-o com \`yarn tauri:dev:all\`, ` +
          `ou aponta ao worker de produção: VITE_AI_WORKER_URL=https://… antes do comando.`,
      })
      exit(1)
      return
    }
    emit({
      type: 'system',
      subtype: 'route_ready',
      aiWorkerUrl,
      waitedMs: Date.now() - preflightStart,
    })
  }

  const startAt = Date.now()

  // 1b. Espera a sessão Firebase restaurar ANTES de tudo (primeira corrida
  // dos evals: com o binário pré-compilado o boot é rápido demais, o run
  // disparava antes do restore e morria com "Authentication expired" — nos
  // smokes o tempo de compilação escondia a corrida). Sem sessão persistida
  // nenhuma, o erro diz exactamente o que fazer.
  {
    const { default: FirebaseAuthService } = await import('@/services/auth/firebaseAuth')
    const auth = FirebaseAuthService.getInstance()
    const AUTH_TIMEOUT_MS = 30_000
    while (!auth.isAuthenticated()) {
      if (Date.now() - startAt > AUTH_TIMEOUT_MS) {
        emit({
          type: 'result',
          subtype: 'error',
          error:
            `no authenticated session after ${AUTH_TIMEOUT_MS / 1000}s — abre o TM Code normal, ` +
            `faz login, e volta a correr o runner (a sessão persistida é herdada).`,
        })
        exit(1)
        return
      }
      await new Promise(r => setTimeout(r, 250))
    }
    emit({ type: 'system', subtype: 'auth_ready', waitedMs: Date.now() - startAt })
  }

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
  const { usePermissionStore } = await import('@/stores/permissionStore')

  let sawActive = false
  let finished = false
  let enqueuedAt: number | null = null
  let redispatches = 0
  // Sessão do RUN, capturada ENQUANTO decorre (streamingSessionId — o idioma
  // do repo). Nos evals sobre fixture virgem, getActiveSession() apontava a
  // uma sessão VAZIA (messageCount:0 no diag): o boot cria uma sessão e o
  // despacho da fila usa outra.
  let runSessionId: string | null = null
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
      // setStatus('error') e setError(message) são DOIS set() separados no
      // mainDispatch.onError — este subscriber acorda no primeiro, antes de
      // a mensagem existir (smoke #6 devolveu "sem mensagem no store" com o
      // erro real a aterrar um tick depois). Espera-se um tick curto para
      // recolher o diagnóstico completo.
      setTimeout(() => {
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
          error: useAgentStore.getState().error
            ?? 'agent status = error (sem mensagem no store)',
          lastMessage,
        })
      }, 120)
      return
    }
    if (state.status !== 'idle') {
      sawActive = true
      if (!runSessionId) {
        try {
          runSessionId = useChatStore.getState().streamingSessionId ?? null
        } catch { /* melhor-esforço */ }
      }
      return
    }
    if (!sawActive || finished) return
    // Mesmo tick de espera do caminho de erro: o idle chega com os deltas
    // finais ainda em buffer (smoke #9: success com text vazio e 105 tokens
    // de completion reais). E se content chegar vazio, os contentBlocks
    // (renderização intercalada) são a segunda fonte do texto.
    setTimeout(() => {
      if (finished) return
      try {
        const chat = useChatStore.getState()
        const session =
          (runSessionId ? chat.sessions.get(runSessionId) : null) ??
          chat.getActiveSession()
        const msgs = session?.messages ?? []
        const last = [...msgs].reverse().find(m => m.role === 'assistant')
        let text = typeof last?.content === 'string' ? last.content : ''
        if (!text && last?.contentBlocks?.length) {
          text = last.contentBlocks
            .map((b) => {
              const block = b as { type?: string; text?: string }
              return block.type === 'text' ? (block.text ?? '') : ''
            })
            .join('')
        }
        // Raio-X (smoke #10: text vazio SOBREVIVEU ao fallback — em vez de
        // mais uma hipótese, o result carrega a anatomia real da sessão).
        const lastX = last as
          | (typeof last & { reasoningContent?: string; isStreaming?: boolean })
          | undefined
        // CUSTO do run, do `requestUsageLog` da sessão (tokens REAIS do
        // provider, não estimativas). Sem isto o eval só sabe dizer "partiu ou
        // não partiu" — e a pergunta que interessa quando se mexe no prompt é
        // "ganhou ou perdeu". `auxiliaryContextTokens` entra à parte porque é
        // o número que a doutrina de contexto discute.
        // TODAS as sessões do processo, não a do run: o `addRequestUsage`
        // escreve na sessão ACTIVA e esta já sabe (ver runSessionId acima) que
        // a activa não é a do run — o boot cria uma, o despacho da fila usa
        // outra. Ler só a do run devolvia zeros com o custo todo ao lado.
        // Um processo headless = um caso, portanto somar tudo é honesto.
        const usage = [...chat.sessions.values()].flatMap(s => s.requestUsageLog ?? [])
        const sum = (pick: (e: (typeof usage)[number]) => number | undefined): number =>
          usage.reduce((acc, e) => acc + (pick(e) ?? 0), 0)
        // Marcos de CONTEXTO da sessão. Sem isto um caso de compactação só
        // pode afirmar "acabou verde" — e hoje já se viu duas vezes um caso
        // passar sem o mecanismo sequer ter corrido (o hook que lia um ficheiro
        // inexistente, o detector que saltava literais). Contar os marcos é o
        // que separa "compactou" de "não precisou de compactar".
        const allMsgs = [...chat.sessions.values()].flatMap(s => s.messages ?? [])
        const boundaries = allMsgs.filter(m => m.kind === 'compact_boundary')
        const compaction = {
          boundaries: boundaries.length,
          budgetMarkers: allMsgs.filter(m => m.kind === 'context_budget').length,
          summarized: boundaries.reduce(
            (n, m) => n + (m.compactMetadata?.messagesSummarized ?? 0), 0,
          ),
          // Maior queda de input entre pedidos consecutivos — a prova de que a
          // compactação libertou espaço, e quanto.
          largestDropTokens: usage.reduce((max, e, i) => {
            if (i === 0) return max
            const prev = usage[i - 1].inputTokens ?? 0
            const cur = e.inputTokens ?? 0
            return prev > cur ? Math.max(max, prev - cur) : max
          }, 0),
        }
        // RELEITURAS — a medida do estrago do orçamento de tool results.
        // Quando o orçamento limpa o conteúdo de um resultado antigo, o modelo
        // fica com um aviso a dizer "relê"; se relê, paga o ficheiro outra vez
        // e parte o prefixo de cache. Contar isto é o que transforma "a barra
        // oscila" numa grandeza: quantas vezes o agente teve de voltar ao que
        // já tinha lido.
        const lidos = new Map<string, number>()
        let rereads = 0
        for (const m of allMsgs) {
          for (const tc of m.toolCalls ?? []) {
            const alvo = (tc.input as Record<string, unknown> | undefined)?.file_path
            if (typeof alvo !== 'string') continue
            if (!/read/i.test(tc.toolName)) continue
            const n = (lidos.get(alvo) ?? 0) + 1
            lidos.set(alvo, n)
            if (n > 1) rereads++
          }
        }

        const cost = {
          requests: usage.length,
          inputTokens: sum(e => e.inputTokens),
          outputTokens: sum(e => e.outputTokens),
          cacheReadInputTokens: sum(e => e.cacheReadInputTokens),
          // Por PEDIDO (o custo do prompt não se soma: repete-se). O máximo é
          // o que o prompt pesa quando está todo montado.
          auxiliaryContextTokensMax: usage.reduce(
            (max, e) => Math.max(max, e.auxiliaryContextTokens ?? 0), 0,
          ),
          usageAvailable: usage.some(e => e.usageAvailable === true),
        }
        finish(0, {
          type: 'result',
          subtype: 'success',
          text,
          cost,
          compaction: { ...compaction, rereads, distinctFilesRead: lidos.size },
          diag: {
            runSessionId,
            sessionId: (session as { id?: string } | undefined)?.id ?? null,
            messageCount: msgs.length,
            lastRoles: msgs.slice(-4).map(m => m.role),
            lastAssistant: lastX
              ? {
                  contentLen: typeof lastX.content === 'string' ? lastX.content.length : -1,
                  blocks: lastX.contentBlocks?.map(b => (b as { type?: string }).type ?? '?') ?? [],
                  reasoningLen: lastX.reasoningContent?.length ?? 0,
                  isStreaming: lastX.isStreaming ?? false,
                }
              : null,
          },
        })
      } catch (err) {
        finish(1, { type: 'result', subtype: 'error', error: String(err) })
      }
    }, 500)
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
    // Re-asserção do YOLO (evals write-file: o set do arranque corria ANTES
    // da hidratação do estado persistido da permissionStore, que o repunha a
    // false — o diff ficava parqueado à espera de um humano inexistente e o
    // run pendurava em awaiting_response até ao tecto). Idempotente; vence
    // qualquer hidratação tardia.
    if (job.yolo && !usePermissionStore.getState().autoModePermissions) {
      usePermissionStore.getState().setAutoModePermissions(true)
      emit({ type: 'system', subtype: 'yolo_reasserted' })
    }
    // Watchdog de despacho (evals 03-08, a "3ª via de perda muda"): o
    // executeQueuedInput pode consumir o lote e o runAgentForPrompt recusar
    // entrada em silêncio (concurrent-guard — o próprio finally dele admite
    // o cenário), tipicamente contra restos de estado persistido no boot.
    // Se nada ficou activo E a fila está vazia passado um tempo razoável,
    // o condutor re-enfileira o job — perda vira retry, com tecto.
    if (
      !sawActive &&
      enqueuedAt !== null &&
      Date.now() - enqueuedAt > 15_000 &&
      getCommandQueueSnapshot().length === 0 &&
      redispatches < 2
    ) {
      redispatches += 1
      enqueuedAt = Date.now()
      emit({ type: 'system', subtype: 'redispatch', attempt: redispatches })
      enqueue({ value: job.task, mode: 'prompt' })
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
  // Antes: limpar um planResumePending herdado de OUTRO projecto/sessão —
  // no executeQueuedInput, o guard de wrong-project engolia o item com uma
  // system message que ninguém vê headless (a intermitência dos evals). Um
  // job de runner é sempre uma tarefa fresca; planos pendentes de outro
  // mundo não lhe dizem respeito.
  try {
    useChatStore.getState().setPlanResumePending?.(null)
  } catch { /* sem plan-resume não há nada a limpar */ }
  enqueuedAt = Date.now()
  enqueue({ value: job.task, mode: 'prompt' })
  emit({ type: 'system', subtype: 'enqueued', queue: getCommandQueueSnapshot().length })
}
