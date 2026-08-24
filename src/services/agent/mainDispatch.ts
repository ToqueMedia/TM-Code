/**
 * NÚCLEO ÚNICO da montagem de dispatch — Fase F1 da FUSÃO DOS RUNNERS
 * (2026-07-18). Este módulo existe porque o mesmo bloco viveu em DOIS corpos
 * (agentRunner.runAgentInternal + usePromptBar.runAgentForPrompt) e divergiu
 * três vezes com custo real: steering só num lado (06-16), bloco volátil só
 * num lado (07-17), classificador removido só num lado (07-17). A regra a
 * partir de agora: mexer na montagem do prompt/volátil = mexer AQUI.
 *
 * Consumidores:
 *  - agentRunner.runAgentInternal (fila serializada, background/auto-wake)
 *  - usePromptBar.runAgentForPrompt (Chat direto)
 *  - parallelTaskRunner (tarefas + agentes de sessão; builder EFÉMERO por
 *    parâmetro — o singleton continua exclusivo do run interativo)
 *
 * Fases seguintes da fusão (F2/F3): união dos callbacks/finalização e do
 * corpo do loop — ver ARCHITECTURE.md "O trono por demolir".
 */

import ContextBuilder from './contextBuilder'
import { appendVolatileReminder } from './volatileAppend'
import ToolExecutor from './toolExecutor'
import { nativeDeferredToolNames } from './toolPolicy'
import AgentService from './agentService'
import MCPService from '../mcp/mcpService'
import { browserSession } from '../browserSessionManager'
import { logger } from '../../utils/logger'
import type { PromptProfile, RouterDiagnostics } from './contextBuilder/auxiliaryRegistry'
import type { AgentCallbacks } from './types'

/**
 * Perfil + hints com que um run arranca.
 *
 * Vivia no intentRouter.ts, que foi APAGADO na auditoria de 2026-07-28: o
 * classificador LLM pré-voo estava morto no caminho vivo há muito (uma
 * classificação "read-only" errada chegou a negar create/edit num run inteiro)
 * e o ficheiro só sobrevivia por causa deste tipo. Hoje só há dois produtores:
 * o bootstrap de TMS abaixo e os overrides internos de comandos — nenhum
 * inspeciona texto livre do utilizador.
 */
export interface IntentClassification {
  profile: PromptProfile
  readOnly: boolean
  source: 'model' | 'fallback' | 'keyword'
  confidence: 'high' | 'medium' | 'low' | 'none'
  /** Short reason for logging / export telemetry. */
  reason: string
  error?: string
  diagnostics?: RouterDiagnostics
}
import {
  useChatStore,
  appendTextDeltaBuffered,
  appendReasoningDeltaBuffered,
  flushBufferedDeltas,
  markReasoningBoundary,
  resolveAllPendingDiffApprovals,
} from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useBillingStore } from '../../stores/billingStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore, selectIsPreviewServerRunning } from '../../stores/layoutStore'
import { t } from '../../i18n/useTranslation'
import {
  buildAugmentedPrompt,
  buildContentParts,
  extractDisplayFromValue,
} from './promptValueHelpers'
import { drainSteerableMessages, joinPromptValues } from './messageQueue'
import { describeImagesViaSidecar } from './visionSidecar'
import { resolveAttachments, resolveDescribedAttachments, resolveImageToDataUri } from '../attachmentService'
import { getTmsTurnTelemetry } from './tmsContext'

export interface MCPToolSummaryLite {
  name: string
  description: string
  serverName: string
}

/** Perfil dedicado do bootstrap de TMS.md — o ÚNICO intent fixo que resta
 *  depois da remoção do classificador (decisão do produto 2026-07-17). */
export const TMS_BOOTSTRAP_INTENT: IntentClassification = {
  profile: 'project_bootstrap',
  readOnly: false,
  source: 'keyword',
  confidence: 'high',
  reason: 'TMS.md bootstrap preflight selected project_bootstrap before the original task',
}

/**
 * Refresca as tools MCP no executor (idempotente — cobre servers ligados a
 * meio da sessão) e devolve os summaries para a secção de routing do prompt.
 */
/**
 * Refresh MCP tools for an agent dispatch. F4: when `projectPath` is set,
 * tools come from that project scope (+ global). A background project-run
 * must not see only the focused project's MCP set.
 */
export function refreshMcpForDispatch(
  projectPath?: string,
  executor?: ToolExecutor,
): MCPToolSummaryLite[] {
  const mcpService = MCPService.getInstance()
  const mcpTools = mcpService.getAllTools(projectPath)
  // Register on the RUN's executor. The main run passes none → the singleton;
  // a background project-run passes its OWN isolated child so it (a) actually
  // receives MCP tools (createIsolatedChild does NOT copy the parent tool map)
  // and (b) does NOT delete/replace the singleton's mcp__* tools out from under
  // a concurrent main run on another project.
  const target = executor ?? ToolExecutor.getInstance()
  if (mcpTools.length > 0) {
    target.registerMCPTools(
      mcpTools,
      browserSession.wrapCallTool((serverName, toolName, args) =>
        mcpService.callTool(serverName, toolName, args, projectPath),
      ),
    )
    // Only the singleton feeds the live main AgentService toolset; a task's
    // QueryEngine reads its child executor directly, so skip the refresh there.
    if (target === ToolExecutor.getInstance()) {
      AgentService.getInstance().refreshTools()
    }
  }
  return mcpTools.map((t) => ({ name: t.name, description: t.description, serverName: t.serverName }))
}

export interface BuildMainSystemPromptArgs {
  /** Raiz do build — projecto, ou o WORKTREE da tarefa (a cópia dela). */
  projectPath: string
  projectType: string
  /** Texto do user (para hashtags de skills + heurística local de perfil). */
  userMessageText: string | undefined
  /** Preflight de TMS.md selecionou o bootstrap dedicado. */
  bootstrapOnly: boolean
  /** Override interno (retomas/caminhos internos) — respeitado tal-e-qual. */
  intentOverride?: IntentClassification | null
  mcpToolSummaries?: MCPToolSummaryLite[]
  /** Builder EFÉMERO (tarefas). Omitido = singleton do run interativo. */
  builder?: ContextBuilder
  /** Contagem de tools do schema — tarefas passam o tamanho do SEU set. */
  coreToolCountOverride?: number
  /** Nomes das tools nativas diferidas — tarefas passam os do SEU set.
   *  Omitido = lidos do executor singleton (mesma regra do coreToolCount). */
  deferredToolNamesOverride?: string[]
  /** Mensagem traz imagens — activa o perfil vision (regras de imagem no prompt). */
  hasImage?: boolean
}

/**
 * Montagem ÚNICA do system prompt (sem classificador): bootstrap usa o perfil
 * dedicado, override interno é respeitado, caso normal segue SEM override —
 * a heurística LOCAL do builder rotula o índice on-demand, sem poder de
 * negação. O bloco volátil fica em getLastVolatileContext() do builder usado.
 */
export async function buildMainSystemPrompt(args: BuildMainSystemPromptArgs): Promise<string> {
  const builder = args.builder ?? ContextBuilder.getInstance()
  const effectiveIntent = args.bootstrapOnly ? TMS_BOOTSTRAP_INTENT : (args.intentOverride ?? null)
  if (effectiveIntent) {
    logger.info(
      'agent',
      `→ Intent (sem router): profile=${effectiveIntent.profile} readOnly=${effectiveIntent.readOnly} — ${effectiveIntent.reason}`,
    )
  }
  const coreToolCount = args.coreToolCountOverride ?? ToolExecutor.getInstance().getCoreToolCount()
  // Só as NATIVAS. As `mcp__*` são diferidas na mesma, mas já se anunciam na
  // secção MCP — deixá-las passar aqui listava cada uma DUAS vezes no prompt.
  const deferredToolNames = args.deferredToolNamesOverride
    ?? nativeDeferredToolNames(ToolExecutor.getInstance().getDeferredToolIndex())
  return builder.buildSystemPrompt(
    args.projectPath,
    args.projectType,
    args.mcpToolSummaries,
    coreToolCount,
    args.userMessageText,
    AgentService.getInstance().getAccessedFilePaths(),
    effectiveIntent ?? undefined,
    { hasImage: args.hasImage, deferredToolNames },
  )
}

/**
 * Apêndice ÚNICO do bloco volátil à mensagem do user (FASE B da recalibração
 * de cache): o system prompt fica byte-estável e o contexto dinâmico
 * (environment/git/árvore/tracker/memórias/reminder) viaja na mensagem.
 * Telemetria à prova de silêncio: warn se vazio (impossível por desenho — o
 * Reminder vive no bloco volátil), info com o tamanho quando segue.
 */
export function appendVolatileToUserContent<T extends { type: string }>(
  userContent: string | T[],
  opts?: { skip?: boolean; builder?: ContextBuilder; surface?: string },
): string | (T | { type: 'text'; text: string })[] {
  if (opts?.skip) return userContent
  const builder = opts?.builder ?? ContextBuilder.getInstance()
  const surface = opts?.surface ?? 'main'
  const volatileCtx = builder.getLastVolatileContext()
  if (!volatileCtx) {
    logger.warn('agent', `[FASE B] bloco volátil VAZIO (${surface}) — inesperado!`)
    return userContent
  }
  logger.info('agent', `[FASE B] volátil → mensagem do user (${volatileCtx.length} chars, ${surface})`)
  // Pure append keeps multimodal arrays intact (text + image_url + reminder).
  return appendVolatileReminder(userContent, volatileCtx)
}

// ═════════════════════ FUSÃO F2 — callbacks do loop ═════════════════════
// O MESMO objeto de callbacks viveu em dois corpos (agentRunner + Chat) e
// divergiu em NOVE pontos com custo real: o Chat perdeu onReasoningComplete
// (blocos de reasoning colados), providerState (continuidade multi-turno),
// o guard de dupla finalização, o fecho automático do tracker, a celebração
// e o `?? 0` defensivo do usage (crash de toLocaleString); o runner perdeu o
// steering com imagens, a mensagem de erro recuperável e o reload do preview.
// A união dos MELHORES comportamentos vive aqui; os call-sites só passam a
// superfície e os flags do run.

/** Códigos de erro upstream de que o user recupera re-enviando o mesmo
 *  prompt ou "Continue" — deteção por código, nunca regex na mensagem. */
export const RECOVERABLE_UPSTREAM_CODES = new Set<string>([
  'SERVER_ERROR',     // 5xx do worker / cloud BYOK
  'NETWORK_ERROR',    // retries de fetch esgotados
  'BYOK_LOCAL_ERROR', // provider local (Ollama / LM Studio) inacessível
  'STREAM_ERROR',     // evento de erro SSE a meio do turno
])

const APPROX_CHARS_PER_TOKEN = 4

export function estimateTokensFromText(value: string): number {
  if (!value) return 0
  return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN)
}

export function estimateTokensFromValue(value: unknown): number {
  if (typeof value === 'string') return estimateTokensFromText(value)
  if (value === null || value === undefined) return 0
  try {
    return estimateTokensFromText(JSON.stringify(value))
  } catch {
    return estimateTokensFromText(String(value))
  }
}

export interface BuildLoopCallbacksArgs {
  surface: 'runner' | 'chat'
  /** Auto-wake/background: sem steering, sem tracker-close, sem celebração,
   *  sem preview reload, e o usage não move o ctx-pill do foreground. */
  isBackgroundRun: boolean
  bootstrapOnly: boolean
  /** Estimativa inicial (system+history+user) — ctx-pill; a contabilidade
   *  real é exclusiva do worker ai-pass-through. */
  initialPromptEstimate: number
  /** Pipeline de imagens no steering (gate de plano + capacidade do modelo
   *  ativo) — sem eles, uma imagem enviada a meio do run degrada para texto
   *  mesmo quando o modelo vê. */
  planAllowsImagePipeline: boolean
  activeModelSupportsImageParts: boolean
  /** Chamado em QUALQUER onError (incl. abort) — o Chat mapeia-o a hadError
   *  para parar a fila e suprimir o re-dispatch do bootstrap. */
  onErrorSignal?: () => void
}

export function buildMainLoopCallbacks(
  args: BuildLoopCallbacksArgs,
): Omit<AgentCallbacks, 'dispatchGeneration'> {
  const agentService = AgentService.getInstance()
  const { isBackgroundRun, bootstrapOnly } = args
  const loopStartTime = Date.now()
  // Guard contra dupla finalização (onDone e onError não podem ambos fechar).
  let finalized = false
  let firstTextReceived = false
  let firstReasoningReceived = false
  let streamedAssistantText = ''
  let estimatedPromptTokens = 0
  let estimatedOutputTokens = 0
  const applyLiveTokenEstimate = (inputDelta: number, outputDelta: number) => {
    if (inputDelta > 0) estimatedPromptTokens += inputDelta
    if (outputDelta > 0) estimatedOutputTokens += outputDelta
    if (inputDelta > 0 || outputDelta > 0) {
      useChatStore.getState().addEstimatedTokenUsage(
        estimatedPromptTokens,
        estimatedOutputTokens,
        !isBackgroundRun,
      )
    }
  }
  const finalizeOnce = () => {
    if (!finalized) {
      finalized = true
      // Aborted runs stamp the interruption on the bubble — the next turn's
      // rebuilt history then tells the model the reply was cut, not concluded.
      useChatStore.getState().finalizeAssistantMessage(
        agentService.isAborted() ? { interrupted: true } : undefined,
      )
    }
  }

  useBillingStore.getState().resetLastRequestStats()
  applyLiveTokenEstimate(args.initialPromptEstimate, 0)
  logger.info('agent', `→ Agent loop starting (${args.surface})...`)

  return {
    // Guards de abort em todos os handlers de stream: depois de
    // handleStop/stopAgentRun o controller está set, mas chunks SSE já em
    // voo continuam a chegar — sem o guard reativavam um status ocupado, o
    // badge cross-window lia isso como um run NOVO (ponto fantasma), e o
    // onDone do unwind carimbava um "done" mentiroso.
    onTextDelta: (delta) => {
      if (agentService.isAborted()) return
      if (!firstTextReceived) {
        firstTextReceived = true
        logger.info('agent', `✓ First text delta received (${Date.now() - loopStartTime}ms into loop)`)
      }
      useAgentStore.getState().setStatus('generating')
      applyLiveTokenEstimate(0, estimateTokensFromText(delta))
      streamedAssistantText += delta
      appendTextDeltaBuffered(delta)
    },
    onReasoningDelta: (delta) => {
      if (agentService.isAborted()) return
      if (!firstReasoningReceived) {
        firstReasoningReceived = true
        logger.info('agent', `✓ Reasoning started (${Date.now() - loopStartTime}ms into loop)`)
      }
      useAgentStore.getState().setStatus('reasoning')
      applyLiveTokenEstimate(0, estimateTokensFromText(delta))
      appendReasoningDeltaBuffered(delta)
    },
    onReasoningComplete: () => {
      if (agentService.isAborted()) return
      // Drena já o buffer para o reasoning ficar visível antes do próximo
      // conteúdo, e marca a fronteira — sem isto, blocos de thinking
      // consecutivos renderizam como um parágrafo corrido.
      flushBufferedDeltas()
      markReasoningBoundary()
    },
    onToolCallPending: (toolId, toolName) => {
      if (agentService.isAborted()) return
      logger.info('agent', `→ Tool call pending: ${toolName} (id: ${toolId})`)
      flushBufferedDeltas()
      useAgentStore.getState().setStatus('applying')
      useChatStore.getState().addPendingToolCall(toolId, toolName)
    },
    onToolCallStart: (toolId, toolName, toolArgs) => {
      if (agentService.isAborted()) return
      logger.info('agent', `→ Executing: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}...)`)
      useChatStore.getState().updateToolCallWithArgs(toolId, toolArgs)
    },
    onToolResult: (toolId, toolName, result, isError) => {
      if (agentService.isAborted()) return
      const resultLen = typeof result === 'string' ? result.length : JSON.stringify(result).length
      logger.info('agent', `✓ ${toolName} completed (${resultLen} chars${isError ? ', ERROR' : ''})`)
      useChatStore.getState().updateToolCallWithResult(toolId, result, isError)
      applyLiveTokenEstimate(estimateTokensFromValue(result), 0)
      // Tool terminou — estamos à espera da próxima resposta do modelo.
      useAgentStore.getState().setStatus('awaiting_response')
    },
    onTurnComplete: (turnNumber, providerState) => {
      logger.info('agent', `✓ Turn ${turnNumber} complete`)
      useChatStore.getState().incrementTurnCount()
      if (providerState) {
        useChatStore.getState().setProviderState(providerState)
      }
    },
    onDone: (finalText) => {
      flushBufferedDeltas()
      if (finalText && finalText !== streamedAssistantText) {
        const suffix = finalText.startsWith(streamedAssistantText)
          ? finalText.slice(streamedAssistantText.length)
          : finalText
        if (suffix) {
          appendTextDeltaBuffered(suffix)
          flushBufferedDeltas()
        }
      }
      // Bootstrap TMS em foreground: mantém o assistant aberto — o caller
      // re-despacha a tarefa ORIGINAL logo a seguir ao loop.
      if (!isBackgroundRun && bootstrapOnly) {
        const tms = getTmsTurnTelemetry()
        if (tms.tmsCreated || tms.tmsAlreadyExists) {
          useAgentStore.getState().setStatus('awaiting_response')
          return
        }
      }
      finalizeOnce()
      // Fecho do tracker num fim limpo: o agente faz o trabalho mas salta o
      // update_tasks de fecho — a última tarefa in_progress ficava a assombrar
      // o AgentTasksPanel. `pending` fica intocado (um /plan seed é todo
      // pending e o onDone dispara logo após o seed). Aborts e background
      // auto-wakes ficam de fora.
      //
      // CRITICAL: if a main-owned background command is still running (e.g.
      // yarn deploy via execute_command_background), do NOT auto-close
      // in_progress tasks. Closing them made openTasks=0 at cmd-exit, so
      // autoWake refused to resume (session momenu-fact 2026-07-24: deploy
      // failed with TS error and the agent never woke). Keep in_progress so
      // the wake gate sees open work and resumes to check_background_commands.
      if (!isBackgroundRun && !agentService.isAborted()) {
        let mainBgRunning = 0
        try {
          // Lazy require (P3.1: registry do motor — módulo puro, sem ciclos).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { processRegistry } = require('./processRegistry') as typeof import('./processRegistry')
          for (const c of processRegistry.getAll()) {
            // 'main' or project-bound main stamp (taskId `project:{id}`).
            if (c.status === 'running' && (c.owner === 'main' || c.owner.startsWith('project:'))) {
              mainBgRunning++
            }
          }
        } catch { /* store unavailable — fall through to auto-close */ }

        if (mainBgRunning > 0) {
          logger.info(
            'agent',
            `→ Skipping tracker auto-close: ${mainBgRunning} background command(s) still running (await auto-wake)`,
          )
        } else {
          // TRACKER POR-SESSÃO: fecha o tracker DESTA sessão do run (main = a
          // sessão em streaming/ativa), não um tracker global.
          const chat = useChatStore.getState()
          const runSid = chat.streamingSessionId ?? chat.activeSessionId ?? ''
          const tasks = runSid ? useAgentStore.getState().getTasksForSession(runSid) : []
          if (runSid && tasks.some(tk => tk.status === 'in_progress')) {
            const closed = tasks.map(tk =>
              tk.status === 'in_progress'
                ? { ...tk, status: 'completed' as const, evidence: tk.evidence || 'Run completed' }
                : tk,
            )
            useAgentStore.getState().setTasksForSession(runSid, closed)
            // F2: persist under the session's own project, not the focused one
            // (a parked main run may finish while the user is viewing project B).
            const sessionPath = chat.sessions.get(runSid)?.projectPath
            const projectPath = sessionPath || useProjectStore.getState().currentProject?.path
            if (projectPath) {
              void import('./taskPersistence')
                .then(({ saveTasksForSession }) => saveTasksForSession(projectPath, runSid, closed))
                .catch(() => { /* persistence is best-effort */ })
            }
          }
        }
      }
      // Um run cancelado NÃO pode acabar em 'idle': a razão terminal de um
      // Stop é 'aborted' (não 'error') e o onDone ainda dispara no unwind —
      // o badge writer mapearia busy→idle para um checkmark mentiroso.
      useAgentStore.getState().setStatus(agentService.isAborted() ? 'cancelled' : 'idle')
      logger.info('agent', `✓ Agent done (total: ${Date.now() - loopStartTime}ms)`)
      useProblemsStore.getState().scanProject().catch(() => {})
      if (!isBackgroundRun) {
        // Preview fresco sem trocar de vista; a resposta final diz ao user
        // para clicar em Preview quando quiser inspecionar.
        const layout = useLayoutStore.getState()
        if (selectIsPreviewServerRunning(layout)) layout.reloadPreview()
      }
    },
    onError: (error) => {
      flushBufferedDeltas()
      resolveAllPendingDiffApprovals(false)
      useAgentStore.getState().setCompactPhase('idle')
      args.onErrorSignal?.()
      if (agentService.isAborted()) {
        useAgentStore.getState().setError(null)
        useAgentStore.getState().setStatus('cancelled')
        logger.info('agent', `Agent run cancelled by user: ${error.message}`)
        finalizeOnce()
        return
      }
      useAgentStore.getState().setStatus('error')
      useAgentStore.getState().setError(error.message)
      logger.info('agent', `✗ Agent error: ${error.message}`)
      finalizeOnce()
      // "O que aconteceu + como recuperar" para as classes de erro em que
      // re-enviar/Continue resolve — por código de ServiceError, nunca regex.
      const errorCode = (error as { code?: string }).code ?? 'UNKNOWN_ERROR'
      if (!isBackgroundRun && RECOVERABLE_UPSTREAM_CODES.has(errorCode)) {
        useChatStore.getState().addSystemMessage(t('chat.recoverableUpstreamError'), 'error')
      }
    },
    onUsageUpdate: (inputTokens, outputTokens, speedApplied = false) => {
      // ?? 0 defensivo: providers com usage parcial passam undefined e
      // .toLocaleString() em undefined rebentava o run inteiro.
      const inTok = inputTokens ?? 0
      const outTok = outputTokens ?? 0
      // O multiplicador real do TM Speed é do worker — o log afirma só que o
      // speed foi servido, sem cravar um número que pode divergir.
      logger.info('agent', `→ Tokens: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out${speedApplied ? ' (TM Speed — billed at the server-side speed rate)' : ''}`)
      // isForeground: runs invisíveis contam para billing/atividade mas não
      // movem o ctx-pill (ele segue o contexto da conversa em foreground).
      useChatStore.getState().addTokenUsage(inTok, outTok, !isBackgroundRun)
      // Display-only ("último pedido"); a cobrança real vive no worker.
      useBillingStore.getState().addLastRequestTokens(inTok + outTok)
    },
    // Marco do orçamento de tool results: fica no histórico/export, não no
    // chat (forma cli-vaz — ver addContextBudgetMarker).
    onContextBudgetApplied: ({ tokensBefore, tokensAfter, clearedCount }) => {
      if (isBackgroundRun) return
      try {
        useChatStore.getState().addContextBudgetMarker(tokensBefore, tokensAfter, clearedCount)
      } catch { /* observability never blocks */ }
    },
    onRequestUsage: (entry) => {
      // Log por-pedido na sessão ativa (export) — best-effort, nunca bloqueia.
      try { useChatStore.getState().addRequestUsage(entry) } catch { /* observability never blocks */ }
    },
    onContextCompression: (event) => {
      if (event.type === 'hooks_start') {
        useAgentStore.getState().setCompactPhase(event.hookType === 'pre_compact' ? 'hooks_pre' : 'hooks_post')
      } else if (event.type === 'compact_start') {
        logger.info('agent', `⟳ Context compression starting (current: ${event.beforeTokens} tokens, trigger: ${event.trigger})...`)
        useAgentStore.getState().setCompactPhase('compressing')
        useAgentStore.getState().setStatus('compressing')
      } else if (event.type === 'compact_end') {
        logger.info('agent', '✓ Context compression complete')
        useAgentStore.getState().setCompactPhase('idle')
        useAgentStore.getState().setStatus('awaiting_response')
        useChatStore.getState().addCompactBoundaryMessage(event.beforeTokens, event.trigger, event.messagesSummarized, event.summary, event.recovery)
      }
    },
    // ── Steering de mensagens em fila (paridade claude-vaz) ──
    // Chamado pelo loop a cada fronteira de turno: drena AQUI, dentro do run
    // vivo, o que o user enfileirou (o idle drain não dispara com o guard
    // preso). Só foreground — auto-wakes ficam de fora e sub-agents nunca
    // recebem este callback. Resultados de sub-agents são EMPURRADOS (nunca
    // polled) e apanhados na mesma fronteira.
    collectSteeringMessages: isBackgroundRun
      ? undefined
      : async () => {
          const { drainSubAgentDeliveries } = await import('./subAgents/autoWake')
          const deliveries = drainSubAgentDeliveries()
          const withDeliveries = (
            v: string | import('../../types/chat').ContentBlockAPI[],
          ): string | import('../../types/chat').ContentBlockAPI[] =>
            !deliveries
              ? v
              : typeof v === 'string'
                ? `${deliveries}\n\n${v}`
                : [{ type: 'text', text: deliveries } as import('../../types/chat').ContentBlockAPI, ...v]

          // Só mensagens steeráveis ANTES da primeira tarefa em fila entram no
          // run vivo (drainSteerableMessages): slash/bash precisam do
          // executeInput, tarefas esperam o idle drain, e um steer reordenado
          // ABAIXO de uma tarefa pertence ao run dela. O corte por sessão
          // impede que uma mensagem enfileirada nOUTRO projecto (fila global)
          // seja absorvida por ESTE run.
          const drained = drainSteerableMessages('next', {
            sessionId: useChatStore.getState().streamingSessionId,
          })
          if (drained.length === 0) return deliveries

          // Coalesce um burst num só turno steered (joinPromptValues preserva
          // a ordem de blocos, igual ao dispatch em lote da fila).
          const merged =
            drained.length > 1
              ? joinPromptValues(drained.map(c => c.value))
              : drained[0]!.value
          const display = extractDisplayFromValue(merged)
          const blocks = typeof merged === 'string' ? undefined : merged
          useChatStore.getState().splitForQueuedMessage(display.text, display.attachments, blocks)

          const resolvers = {
            resolveAttachmentXml: resolveAttachments,
            resolveImageDataUri: resolveImageToDataUri,
          }
          // Mesmo split visão-nativa vs sidecar do send inicial — sem isto,
          // uma imagem em fila a meio do run degradava para texto mesmo com o
          // modelo ativo a ver (o runner viveu meses só-texto aqui).
          if (args.planAllowsImagePipeline && display.attachments.some(a => a.type === 'image')) {
            const parts = await buildContentParts(merged, resolvers)
            if (parts && args.activeModelSupportsImageParts) return withDeliveries(parts)
            if (parts) {
              const description = await describeImagesViaSidecar(parts)
              if (description) {
                const textOnly = await buildAugmentedPrompt(merged, {
                  ...resolvers,
                  resolveAttachmentXml: resolveDescribedAttachments,
                })
                return withDeliveries(`${textOnly}\n\n<image_description source="image-analysis">\n${description}\n</image_description>`)
              }
            }
          }
          // Fallback só-texto: attachments viram XML, imagens viram markers;
          // @-mentions deliberadamente não re-resolvidas aqui.
          const text = await buildAugmentedPrompt(merged, resolvers)
          return withDeliveries(text && text.trim().length > 0 ? text : display.text)
        },
  }
}
