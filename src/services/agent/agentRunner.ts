import { invoke } from '@/utils/invokeMetrics'
import { logger } from '@/utils/logger'
import { useChatStore, appendUiTextDeltaBuffered, flushBufferedDeltas } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useBillingStore } from '../../stores/billingStore'
import { t } from '../../i18n/useTranslation'
import AgentService from './agentService'
import type { IntentClassification } from './mainDispatch'
import {
  refreshMcpForDispatch,
  buildMainSystemPrompt,
  appendVolatileToUserContent,
  buildMainLoopCallbacks,
  estimateTokensFromText,
  estimateTokensFromValue,
} from './mainDispatch'
import { getQueryGuard } from './queryGuard'
import type { OpenAIContentPart } from './types'
import ToolExecutor from './toolExecutor'
import { browserSession } from '../browserSessionManager'
import { getProjectSessionsDir } from '../projectStatePaths'
import { resolveAttachments, resolveImageToDataUri } from '../attachmentService'
import { buildAugmentedPrompt, buildContentParts, downgradeHistoryToText } from './promptValueHelpers'
import { describeImagesViaSidecar } from './visionSidecar'
// joinPromptValues: agora só usado pelo steering em mainDispatch (F2).
import { MODEL_PROFILES, getProfileForPlan } from './modelProfiles'
import { resolveMentionContext, collectChangedFileContext, applyMentionResolution } from './atMentions'
import {
  buildTmsBootstrapOnlyPrompt,
  getTmsBootstrapCompleteMessageKey,
  getTmsBootstrapStartMessageKey,
  runTmsPreflight,
  type TmsPreflightResult,
} from './tmsBootstrap'
import { getTmsTurnTelemetry, markOriginalTaskFailed } from './tmsContext'
import type { Attachment, ConversationMessage, PromptBlock } from '../../types/chat'

interface RunAgentOptions {
  /** Whether to add a user message to the chat. Default: true */
  addUserMessage?: boolean
  /** Text to show in the user bubble. Defaults to the prompt itself. */
  userMessageText?: string
  /** Attachments to display alongside the user message in the chat bubble. */
  userMessageAttachments?: Attachment[]
  /** Original prompt blocks for preserving attachment order in conversation history. */
  userMessageBlocks?: PromptBlock[]
  /** Optional content blocks used only for the model payload, not the transcript. */
  modelMessageBlocks?: PromptBlock[]
  /** Use existing conversation history instead of empty. Default: false */
  useConversationHistory?: boolean
  /**
   * Run with cwd-scoped tools: no project-store entry required, file writes go
   * directly to disk without diff approval, and CWD defaults to the project
   * path or the user's home directory. Must be set explicitly by the caller.
   * Today the only caller is /plan (planCommand.ts) — the architect turn needs
   * the tool executor to resolve paths via its own cwd (enableCmdMode) instead
   * of useProjectStore.currentProject, and must skip the TMS preflight. Always
   * paired with `systemPromptOverride`; the old cwd-scoped system prompt
   * (buildCmdModeSystemPrompt) was removed with the Terminal chat surface.
   */
  cmdOnlyMode?: boolean
  /**
   * When true, skip the internal `chatStore.startAssistantMessage()` call.
   * Used by callers that already created an assistant placeholder bubble
   * with interim text (e.g. /te2e showing "Starting browser session…"
   * before the slow MCP boot). Without this, runAgentInternal would create
   * a SECOND empty assistant bubble and confuse the streaming target.
   */
  skipStartAssistantMessage?: boolean
  /**
   * Replace the default IDE system prompt with a caller-supplied one. Used by
   * /plan to swap in a pure architect role — without this, the regular IDE
   * "coding agent" instructions sit alongside the architect prompt sent as a
   * user message, and the model defaults to building things instead of
   * producing PLAN.md. When set, ContextBuilder is bypassed entirely.
   */
  systemPromptOverride?: string
  /**
   * Raw USER-TYPED text to resolve @-mentions from (atMentions.ts). Set by
   * callers that forward real user input from a prompt surface. When
   * unset, mentions resolve from the text blocks of `modelMessageBlocks` /
   * `userMessageBlocks` if present — system-generated prompts (autoWake,
   * compaction, slash internals) carry neither and get NO mention
   * resolution, same scoping as before the claude-vaz parity port.
   */
  mentionText?: string
  /**
   * Background/automatic run (auto-wake after a sub-agent or background command
   * finishes). Suppresses the seasonal goal celebration — only user-initiated
   * runs "score" a goal. Default: false.
   */
  isBackgroundRun?: boolean
  /** Explicit history to send to the model. Used when resuming the original
   *  request after TMS bootstrap without duplicating the visible user bubble. */
  conversationHistoryOverride?: ConversationMessage[]
  /** Force a known task profile for internal slash-command flows. */
  intentOverride?: IntentClassification
}

/**
 * Serialization chain — each invocation awaits the previous one to fully
 * settle before starting. We *cannot* simply drop concurrent calls: the
 * message queue dispatches a queued prompt as soon as `queryGuard` reports
 * idle, but the previous invocation's `finally` (cleanup, cwd-scope disable)
 * may still be running. With a boolean "running" guard the queued prompt
 * would be dropped silently and never appear in the message list. Chaining
 * ensures every call actually runs while still preventing overlap.
 */
let lastRun: Promise<void> = Promise.resolve()

/**
 * Serialize ANY agent dispatch through the shared `lastRun` chain — each call
 * awaits the previous one's FULL completion (its `finally`: cleanup +
 * `queryGuard.end()`) before starting. This is what stops two dispatchers — the
 * message-queue drain, an auto-wake delivering sub-agent/background results, a
 * slash command — from both clearing `tryStart()` in the reserve→tryStart
 * window and one losing as "concurrent runAgentLoop detected".
 *
 * Queued messages were starved when one dispatch path called `runAgentLoop`
 * directly while auto-wake ran on this chain: the queued prompt kept colliding
 * and being rejected until all background activity ceased. Routing every agent
 * dispatch through `enqueueSerializedRun` restores per-turn draining.
 */
export function enqueueSerializedRun<T>(task: () => Promise<T>): Promise<T> {
  const prev = lastRun
  const run = (async () => {
    // Swallow prior errors — one failed turn must not starve the queue.
    try { await prev } catch { /* ignore */ }
    return task()
  })()
  // Store a never-rejecting void version so the next caller's `await prev` never throws.
  lastRun = run.then(() => {}, () => {})
  return run
}

/**
 * Shared agent invocation — wires up all the chatStore/agentStore callbacks.
 * Used by both PromptInput.handleSend and slash command handlers.
 */
export async function runAgentWithCallbacks(
  prompt: string,
  options: RunAgentOptions = {}
): Promise<void> {
  await enqueueSerializedRun(() => runAgentInternal(prompt, options))
}

async function runAgentInternal(
  prompt: string,
  options: RunAgentOptions
): Promise<void> {
  // ANTI-RESSURREIÇÃO (Bloco A item 2, 2026-07-17): epoch do guard no início
  // do dispatch. Stop durante a preparação → cancelLoop aborta o controller
  // ANTIGO (o novo só nasce dentro do runAgentLoop) e forceEnd AVANÇA a
  // generation. Compara-se antes de arrancar o loop: mudou ⇒ houve Stop ⇒
  // esta preparação é zombie e morre aqui, com o finally a limpar. Sem isto,
  // o run ressuscitava (controller fresco não-abortado passa a guarda
  // pré-voo), o guard ficava preso e a mensagem seguinte apodrecia na fila.
  const dispatchGeneration = getQueryGuard().generation
  const {
    addUserMessage = true,
    userMessageText,
    userMessageAttachments,
    userMessageBlocks,
    modelMessageBlocks,
    useConversationHistory = false,
    cmdOnlyMode = false,
    skipStartAssistantMessage = false,
    systemPromptOverride,
    mentionText,
    isBackgroundRun = false,
    conversationHistoryOverride,
    intentOverride,
  } = options

  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  const projectStore = useProjectStore.getState()
  const currentProject = projectStore.currentProject
  const projectPath = currentProject?.path || ''

  // Resolve CWD for cwd-scoped tool execution.
  // Prefer the open project path so the agent operates in context;
  // fall back to home directory when launched without a project.
  let cmdCwd = ''
  if (cmdOnlyMode) {
    try {
      const home = await invoke<string>('get_home_directory')
      cmdCwd = projectPath || home
    } catch {
      cmdCwd = projectPath || ''
    }
  }

  // Ensure session exists
  let sessionId = chatStore.activeSessionId
  if (!sessionId) {
    sessionId = chatStore.createSession(cmdCwd || projectPath)
  }
  // F2: freeze the session THIS run owns BEFORE any await. A project switch
  // mid-prep would otherwise move activeSessionId and park would drop the
  // session, or startAssistantMessage would write into the wrong project.
  const boundSessionId = sessionId
  useChatStore.getState().pinStreamingSession(boundSessionId)

  const historyBeforeCurrentUser = conversationHistoryOverride
    ?? useChatStore.getState().conversationHistory

  // Pull the agent service early so we can ask it about the upcoming turn
  // (specifically, whether reasoning is requested) before creating the
  // assistant message. The actual prompt + tools setup still happens
  // later — this is just an early handle to a singleton.
  const agentService = AgentService.getInstance()

  // Add user message to chat (with optional attachments and block order)
  if (addUserMessage) {
    chatStore.addUserMessage(
      userMessageText || prompt,
      userMessageAttachments,
      userMessageBlocks,
    )
    logger.info('agent', `→ User message sent (${(userMessageText || prompt).length} chars)`)
  }

  // Persist pasted images to the session's disk cache and stamp their paths
  // onto the just-added user message, so the agent can re-view them after a
  // reload without the user re-sending (the in-memory base64 is stripped on
  // save). Fire-and-forget — the path stamp triggers its own debounced save.
  if (userMessageAttachments?.some(a => a.type === 'image' && !a.path && a.base64)) {
    const sid = chatStore.activeSessionId
    if (sid) {
      void import('../imageCacheService').then(async ({ storeSessionImages }) => {
        const paths = await storeSessionImages(sid, userMessageAttachments)
        if (Object.keys(paths).length > 0) {
          useChatStore.getState().setAttachmentPathsOnLastUserMessage(paths)
        }
      }).catch(() => { /* cache miss → falls back to re-send behaviour */ })
    }
  }

  // Stop before starting an assistant turn when billing has already told us
  // service is blocked. This prevents reload + queued "continue" from
  // replaying into the API and creating a credit-error loop.
  const billingState = useBillingStore.getState()
  if (!billingState.isActive || billingState.noCredits || billingState.status === 'rejected') {
    const message = !billingState.isActive
      ? t('chat.accountInactive')
      : `${t('chat.noCredits')}: ${t('chat.noCreditsRemaining')} ${t('chat.buyCredits')}.`
    chatStore.addSystemMessage(message, 'error')
    agentStore.setStatus('idle')
    return
  }

  let tmsPreflight: TmsPreflightResult | null = null
  if (
    projectPath &&
    addUserMessage &&
    !cmdOnlyMode &&
    !isBackgroundRun &&
    !useProjectStore.getState().tmsBootstrapping
  ) {
    tmsPreflight = await runTmsPreflight({
      projectPath,
      originalUserMessageDisplayed: true,
      originalUserMessage: userMessageText ?? prompt,
    })
  }
  const bootstrapOnly = tmsPreflight?.shouldBootstrap === true

  // claude-vaz parity: a missing TMS.md never blocks or redirects the task
  // (shouldBootstrap is permanently false for 'missing' — see tmsBootstrap).
  // Instead, surface the /init hint ONCE per project open. noTmsFile is only
  // set when the project has meaningful content (projectHasContent.ts), so
  // empty folders don't get nagged — same gating as claude-vaz onboarding.
  if (tmsPreflight?.reason === 'missing') {
    const projectStoreState = useProjectStore.getState()
    if (projectStoreState.noTmsFile) {
      projectStoreState.setNoTmsFile(false)
      chatStore.addSystemMessage(t('common.noTmsFile'), 'info')
    }
  }

  const rawHistory = bootstrapOnly
    ? historyBeforeCurrentUser
    : conversationHistoryOverride
      ? conversationHistoryOverride
      : useConversationHistory
        ? useChatStore.getState().conversationHistory
        : []
  // hasImageForIntent morreu com o router (as imagens seguem multimodais
  // independentemente de perfil — o sidecar de visão é decidido no worker).

  // Reset the per-request token counter at the START of each new request so
  // the chat indicator shows tokens for the CURRENT request only (not the
  // session-cumulative total). A "request" = one runAgentInternal invocation,
  // which can internally span many model turns (tool loops) — those all
  // accumulate into the same counter. Queued messages get coalesced upstream
  // (joinPromptValues), so a batched 3-message prompt is still ONE request.
  chatStore.resetTokenUsage()

  // Start assistant message — unless the caller pre-created one (e.g. /te2e
  // shows a "Starting browser session…" placeholder during the slow MCP
  // boot, then streams into that same bubble). Creating a second one would
  // leave the placeholder orphaned with the streaming target diverging.
  if (!skipStartAssistantMessage) {
    // Stamp the message with whether this turn requested reasoning. The
    // MessageBubble uses this to suppress reasoning blocks when the user
    // didn't ask for them (BYOK reasoning models sometimes keep emitting
    // chain-of-thought even when the disable param is set correctly).
    // boundSessionId: write into the session this run started on, not the
    // currently focused one (F2 mid-run project switch).
    chatStore.startAssistantMessage(
      agentService.isThinkingRequestedForNextTurn(),
      agentService.getEffortStampForNextTurn(),
      boundSessionId,
    )
  }
  if (bootstrapOnly) {
    appendUiTextDeltaBuffered(`${t(getTmsBootstrapStartMessageKey(tmsPreflight!))}\n\n`)
    flushBufferedDeltas()
  }

  // FUSÃO F1: refresh MCP + summaries no núcleo único (mainDispatch).
  const toolExecutor = ToolExecutor.getInstance()
  // F4: register MCP tools for THIS run's project (not only the focused one).
  const mcpToolSummaries = refreshMcpForDispatch(projectPath || undefined)
  if (mcpToolSummaries.length > 0) {
    logger.info('agent', `→ MCP tools: ${mcpToolSummaries.length} tools registered`)
  }

  // In-window multi-project (F2): bind THIS run to the project it started on
  // so a later openProject switch does not re-point getProjectRoot() / path
  // scope / permission grants at the newly focused project mid-flight.
  // Cleared in finally / bailStopPrep. Null project leaves unbound.
  //
  // MUST run BEFORE setStatus('awaiting_response'): projectAgentStatusService
  // stamps the cross-window badge on the busy transition, and it reads the
  // bound project context first. Setting status first wrote the badge to a
  // STALE context (previous project) or the focused project while a
  // background project-run still owned the previous tree — two recents
  // showed "running" for one agent (2026-07-24).
  const boundProjectContext =
    currentProject?.id && currentProject.path
      ? { projectId: currentProject.id, projectPath: currentProject.path }
      : null
  if (boundProjectContext) {
    toolExecutor.setProjectContext(boundProjectContext)
  }

  // 'awaiting_response': prompt is about to be sent; nothing has streamed yet.
  // Flips to 'reasoning' or 'generating' once the first delta lands.
  agentStore.setStatus('awaiting_response')
  logger.info('agent', '⟳ Status: awaiting_response')

  // Checkpoint de prep (2ª ronda do bug Bloco-A-2): um Stop (forceEnd →
  // generation avança) tem de matar este dispatch na PRÓXIMA fronteira de
  // await — não no fim da prep inteira. O dispatch seguinte espera esta
  // promise (enqueueSerializedRun), por isso cada segundo de prep zombie é
  // um segundo em que o reenvio do developer apodrece na fila ("só arrancou
  // passado um tempo"). A limpeza de UI só corre se NENHUM run mais novo
  // ocupou o guard — o estado/bolha são dele, não deste zombie; o cmd-mode
  // é solto aqui porque os returns pré-try não passam pelo finally.
  const bailStopPrep = (): boolean => {
    if (getQueryGuard().generation === dispatchGeneration) return false
    logger.info('agent', 'Stop durante a preparação — dispatch zombie abandonado no checkpoint')
    if (cmdOnlyMode && cmdCwd) {
      try { ToolExecutor.getInstance().disableCmdMode() } catch { /* best-effort */ }
    }
    if (boundProjectContext) {
      try { ToolExecutor.getInstance().setProjectContext(null) } catch { /* best-effort */ }
    }
    if (!getQueryGuard().isActive) {
      agentStore.setStatus('cancelled')
      useChatStore.getState().finalizeAssistantMessage()
    }
    return true
  }

  // Set disk directory for large result persistence (survives session reloads).
  // Stored in the app's per-project sessions dir, outside the user's repo tree.
  if (currentProject?.path) {
    const { useChatStore } = await import('../../stores/chatStore')
    const sessionId = useChatStore.getState().activeSessionId
    if (sessionId) {
      const dir = `${await getProjectSessionsDir(currentProject.path)}/${sessionId}.large-results`
      // Ensure directory exists BEFORE setting the dir — prevents race
      // where persistLargeResultToDisk fires before mkdir completes.
      await invoke('create_directories_all', { path: dir }).catch(() => {})
      toolExecutor.setLargeResultsDir(dir)
    }
  }

  // Enable cwd-scoped execution on the executor — direct disk writes,
  // cwd-scoped path validation.
  // Always paired with disableCmdMode() in the finally block below.
  if (cmdOnlyMode && cmdCwd) {
    toolExecutor.enableCmdMode(cmdCwd)
    logger.info('agent', `→ cwd-scoped execution enabled: ${cmdCwd}`)
  }

  // FUSÃO F1: montagem do prompt no NÚCLEO ÚNICO (mainDispatch) — a mesma
  // função serve o Chat direto, este runner e as tarefas. Histórico da
  // divergência 3× e doutrina no cabeçalho do módulo.
  let systemPrompt: string
  logger.info('agent', '→ Building system prompt...')
  const promptBuildStart = Date.now()
  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride
  } else {
    const bootstrapUserMessageText = bootstrapOnly && tmsPreflight
      ? buildTmsBootstrapOnlyPrompt(tmsPreflight, userMessageText ?? prompt)
      : null
    if (bailStopPrep()) return
    systemPrompt = await buildMainSystemPrompt({
      projectPath,
      projectType: currentProject?.projectType || 'unknown',
      userMessageText: bootstrapUserMessageText ?? userMessageText,
      bootstrapOnly,
      intentOverride,
      mcpToolSummaries,
      hasImage: userMessageAttachments?.some(a => a.type === 'image') ?? false,
    })
  }
  logger.info('agent', `✓ System prompt built (${systemPrompt.length} chars, ${Date.now() - promptBuildStart}ms)`)
  if (bailStopPrep()) return

  // Get conversation history
  logger.info('agent', `→ Conversation history: ${rawHistory.length} messages`)

  agentService.setSystemPrompt(systemPrompt)
  logger.info('agent', '→ System prompt set on agent service')

  // ── Build user content (text-only or multimodal) ──
  // Same split as usePromptBar: paid plans send real image_url content parts,
  // free plans receive flattened text with <attached_image>/<attached_file> XML.
  //
  // The gate is `hasAnyAttachments` (not just images) so file/folder attachments
  // are also resolved via buildAugmentedPrompt → resolveAttachmentXml. Without
  // this, non-image attachments would be visible in the chat bubble but their
  // content would never reach the model.
  const billingPlan = useBillingStore.getState().plan
  const supportsMultimodal = billingPlan !== 'explorer'
  const hasAnyAttachments = (userMessageAttachments?.length ?? 0) > 0
  const hasImageAttachments = userMessageAttachments?.some(a => a.type === 'image') ?? false

  let userContent: string | OpenAIContentPart[] = bootstrapOnly && tmsPreflight
    ? buildTmsBootstrapOnlyPrompt(tmsPreflight, userMessageText ?? prompt)
    : prompt

  const blocksForModel = modelMessageBlocks ?? userMessageBlocks
  if (!bootstrapOnly && hasAnyAttachments && blocksForModel) {
    const imageCount = userMessageAttachments?.filter(a => a.type === 'image').length ?? 0
    const fileCount = (userMessageAttachments?.length ?? 0) - imageCount
    logger.info('agent', `→ Processing attachments (${imageCount} images, ${fileCount} files)...`)
    const attachStart = Date.now()
    const promptResolvers = {
      resolveAttachmentXml: resolveAttachments,
      resolveImageDataUri: resolveImageToDataUri,
    }

    // Multimodal path — only when there are actual images AND the plan supports it.
    // Capability vs política: o PLANO decide se imagens são permitidas
    // (billing); o PERFIL do modelo decide COMO chegam — image_url nativo
    // para modelos com visão, descrição auxiliar para os restantes.
    let visionDescribed = false
    if (hasImageAttachments && supportsMultimodal) {
      const modelName = useAgentStore.getState().modelName
      const activeProfile = modelName && MODEL_PROFILES[modelName]
        ? MODEL_PROFILES[modelName]
        : getProfileForPlan(billingPlan)

      const parts = await buildContentParts(blocksForModel, promptResolvers)
      if (parts && activeProfile.supportsAttachments) {
        userContent = parts
      } else if (parts) {
        // Modelo ativo sem visão → uma descrição auxiliar vira texto para o
        // agente principal. Indisponível → null → fallback XML honesto.
        const description = await describeImagesViaSidecar(parts)
        if (description) {
          const textOnly = await buildAugmentedPrompt(blocksForModel, promptResolvers)
          userContent =
            `${textOnly}\n\n<image_description source="image-analysis">\n${description}\n</image_description>`
          visionDescribed = true
        }
      }
    }

    // Text fallback — handles file/folder attachments (resolveAttachmentXml)
    // AND image placeholders when multimodal isn't available or failed.
    if (typeof userContent === 'string' && !visionDescribed) {
      userContent = await buildAugmentedPrompt(blocksForModel, promptResolvers)
    }
    logger.info('agent', `✓ Content parts built (${Date.now() - attachStart}ms)`)

    // Diagnóstico decisivo do caminho das imagens — quando um utilizador
    // reporta "o modelo diz que não recebeu a imagem", esta linha diz a
    // verdade num relance (report 2026-06-12, Gemini/Vertex).
    if (hasImageAttachments) {
      const sentAsParts = typeof userContent !== 'string'
        && userContent.some(p => p.type === 'image_url')
      if (sentAsParts) {
        logger.info('agent', `✓ ${imageCount} image(s) embedded as image_url parts`)
      } else if (visionDescribed) {
        logger.info('agent', `✓ ${imageCount} image(s) described for text-only model`)
      } else {
        logger.warn(
          'agent',
          `⚠ image(s) DEGRADED to text placeholder — model will never see pixels. ` +
          `plan=${billingPlan} supportsMultimodal=${supportsMultimodal} ` +
          `(null parts = resolveImageDataUri failed or byte cap; or image description unavailable)`,
        )
      }
    }
  }

  // ── @-mentions + external-modification sweep (claude-vaz parity) ──
  // Resolves user-typed @path mentions into synthetic read_file /
  // list_directory tool context appended AFTER the prompt, and injects
  // "Note: X was modified..." reminders for files the model has in context
  // that changed on disk. Runs AFTER enableCmdMode so path scoping matches
  // the turn's execution mode. See atMentions.ts for the full rationale.
  const mentionSource = mentionText
    ?? (blocksForModel
      ? blocksForModel.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : null)
  if (!bootstrapOnly) try {
    const mentionResolution = mentionSource
      ? await resolveMentionContext(mentionSource)
      : { contextText: '', imageParts: [], resolvedPaths: [] }
    const changedContext = await collectChangedFileContext()
    if (mentionResolution.contextText || mentionResolution.imageParts.length > 0 || changedContext) {
      const applied = applyMentionResolution(
        userContent, mentionResolution, changedContext, supportsMultimodal,
      )
      userContent = applied.userContent
      // Persist on the user bubble (added above OR by the caller when
      // addUserMessage=false) so rebuildConversationHistory re-emits the
      // context on follow-up turns instead of letting it evaporate.
      if (applied.persistedContext) {
        useChatStore.getState().setMentionContextOnLastUserMessage(applied.persistedContext, applied.resolvedPaths)
      }
    }
  } catch {
    // Mention resolution must never block a send — worst case the model
    // reads the files itself via tools.
  }

  const history = supportsMultimodal
    ? rawHistory
    : downgradeHistoryToText(rawHistory)

  // FUSÃO F1: apêndice do volátil no núcleo único (antes da estimativa, para
  // o ctx-pill contar o bloco volátil que segue na mensagem).
  userContent = appendVolatileToUserContent(userContent, {
    skip: !!systemPromptOverride,
    surface: 'runner',
  }) as typeof userContent

  // Estimativa inicial (system+history+user) — só ctx-pill; a contabilidade
  // real é exclusiva do worker ai-pass-through.
  const initialPromptEstimate = estimateTokensFromText(systemPrompt)
    + estimateTokensFromValue(history)
    + estimateTokensFromValue(userContent)

  try {
    if (bailStopPrep()) return
    // FUSÃO F2: callbacks do loop no NÚCLEO ÚNICO (buildMainLoopCallbacks). O
    // objeto inline viveu aqui e no Chat e divergiu em 9 pontos; a união dos
    // melhores comportamentos vive em mainDispatch.ts. Slash/auto-wake não
    // fazem steer de imagens — supportsMultimodal (plano) chega para ambos os
    // flags de imagem deste caminho.
    await agentService.runAgentLoop(userContent, history, {
      dispatchGeneration,
      ...buildMainLoopCallbacks({
        surface: 'runner',
        isBackgroundRun,
        bootstrapOnly,
        initialPromptEstimate,
        planAllowsImagePipeline: supportsMultimodal,
        activeModelSupportsImageParts: supportsMultimodal,
      }),
    })

    if (!isBackgroundRun && bootstrapOnly) {
      const tms = getTmsTurnTelemetry()
      if (tms.tmsCreated || tms.tmsAlreadyExists) {
        appendUiTextDeltaBuffered(`\n\n${t(getTmsBootstrapCompleteMessageKey(tms.tmsCreated))}\n\n`)
        flushBufferedDeltas()
        await runAgentInternal(prompt, {
          ...options,
          addUserMessage: false,
          skipStartAssistantMessage: true,
          conversationHistoryOverride: historyBeforeCurrentUser,
        })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!bootstrapOnly) {
      markOriginalTaskFailed(message)
      if (!isBackgroundRun) {
        useChatStore.getState().addSystemMessage(`A tarefa não pôde continuar: ${message}`, 'error')
      }
    }
    throw err
  } finally {
    // Always restore IDE mode regardless of how the loop exited
    if (cmdOnlyMode && cmdCwd) {
      toolExecutor.disableCmdMode()
    }
    // Unbind multi-project context so the next main run (possibly on a
    // different project after a mid-run switch) re-binds cleanly.
    if (boundProjectContext) {
      toolExecutor.setProjectContext(null)
    }
    // Reset compact phase in case compression was in-flight when the loop
    // exited (error, stop, or unexpected break). Without this, stale phases
    // like 'compressing' persist in the UI after the agent goes idle.
    agentStore.setCompactPhase('idle')
    // Restore the preview pane if a browser-driven session hid it. Safe
    // when no session was active (no-op).
    browserSession.endSession()

    // NOTA (2026-06): o antigo persistTokensConsumed (write client-side de
    // valores ABSOLUTOS de consumo no Firestore) foi removido — a
    // contabilidade é agora exclusiva do worker ai-pass-through (increments
    // atómicos server-side). Reintroduzir writes de billing no cliente
    // recriaria o last-writer-wins entre dispositivos e o clobber do
    // cycle-reset que motivaram a migração.
  }
}
