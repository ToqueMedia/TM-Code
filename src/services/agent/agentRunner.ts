import { invoke } from '@/utils/invokeMetrics'
import { logger } from '@/utils/logger'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, markReasoningBoundary, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { useBillingStore } from '../../stores/billingStore'
import { triggerGoalCelebration } from '../../stores/celebrationStore'
import { t } from '../../i18n/useTranslation'
import AgentService from './agentService'
import type { OpenAIContentPart } from './types'
import ContextBuilder from './contextBuilder'
import { classifyIntent } from './intentRouter'
import ToolExecutor from './toolExecutor'
import MCPService from '../mcp/mcpService'
import { browserSession } from '../browserSessionManager'
import { getProjectSessionsDir } from '../projectStatePaths'
import { resolveAttachments, resolveImageToDataUri } from '../attachmentService'
import { buildAugmentedPrompt, buildContentParts, downgradeHistoryToText, extractDisplayFromValue } from './promptValueHelpers'
import { dequeueAllMatching, isSlashCommand, joinPromptValues } from './messageQueue'
import { describeImagesViaSidecar } from './visionSidecar'
import { MODEL_PROFILES, getProfileForPlan } from './modelProfiles'
import { resolveMentionContext, collectChangedFileContext, applyMentionResolution } from './atMentions'
import type { Attachment, PromptBlock } from '../../types/chat'

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
   * Run in CLI/CMD-only mode: no project required, file writes go directly to
   * disk without diff approval, CWD is the user's home directory.
   * Must be set explicitly by the caller — never derived implicitly from project state.
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
   * callers that forward real user input (CMD mode executePrompt). When
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
}

const APPROX_CHARS_PER_TOKEN = 4

function estimateTokensFromText(value: string): number {
  if (!value) return 0
  return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN)
}

function estimateTokensFromValue(value: unknown): number {
  if (typeof value === 'string') return estimateTokensFromText(value)
  if (value === null || value === undefined) return 0
  try {
    return estimateTokensFromText(JSON.stringify(value))
  } catch {
    return estimateTokensFromText(String(value))
  }
}

/**
 * Serialization chain — each invocation awaits the previous one to fully
 * settle before starting. We *cannot* simply drop concurrent calls: the
 * message queue dispatches a queued prompt as soon as `queryGuard` reports
 * idle, but the previous invocation's `finally` (cleanup, CMD-mode disable)
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
 * Chat-mode queued messages were starved precisely because they dispatched
 * `runAgentLoop` DIRECTLY (off this chain) while auto-wake ran on it: the queued
 * prompt kept colliding and being rejected until all background activity ceased
 * ("only at session end"). Terminal mode already routes every dispatch through
 * here (via runAgentWithCallbacks), which is why it behaved as expected.
 * Routing the Chat queue through `enqueueSerializedRun` too restores per-turn
 * draining.
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
  } = options

  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  const projectStore = useProjectStore.getState()
  const currentProject = projectStore.currentProject
  const cmdModePath = projectStore.cmdModeProjectPath
  const projectPath = currentProject?.path || cmdModePath || ''

  // Resolve CWD and home directory for CLI-only mode.
  // Prefer the open project path so the agent operates in context;
  // fall back to home directory when CMD mode is launched without a project.
  let cmdCwd = ''
  let cmdHomeDir: string | null = null
  if (cmdOnlyMode) {
    try {
      const home = await invoke<string>('get_home_directory')
      cmdHomeDir = home
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
    chatStore.startAssistantMessage(agentService.isThinkingRequestedForNextTurn())
  }
  // 'awaiting_response': prompt is about to be sent; nothing has streamed yet.
  // Flips to 'reasoning' or 'generating' once the first delta lands.
  agentStore.setStatus('awaiting_response')
  logger.info('agent', '⟳ Status: awaiting_response')

  // Refresh MCP tools before building prompt (handles mid-session server changes)
  const mcpService = MCPService.getInstance()
  const mcpTools = mcpService.getAllTools()
  const toolExecutor = ToolExecutor.getInstance()
  if (mcpTools.length > 0) {
    toolExecutor.registerMCPTools(
      mcpTools,
      browserSession.wrapCallTool((serverName, toolName, args) =>
        mcpService.callTool(serverName, toolName, args),
      ),
    )
    AgentService.getInstance().refreshTools()
    logger.info('agent', `→ MCP tools: ${mcpTools.length} tools registered`)
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

  // Enable CLI mode on the executor — direct disk writes, CWD-scoped path validation.
  // Always paired with disableCmdMode() in the finally block below.
  if (cmdOnlyMode && cmdCwd) {
    toolExecutor.enableCmdMode(cmdCwd)
    logger.info('agent', `→ CMD mode enabled: ${cmdCwd}`)
  }

  // Build system prompt with MCP tool info
  const mcpToolSummaries = mcpTools.map(t => ({
    name: t.name,
    description: t.description,
    serverName: t.serverName,
  }))
  const contextBuilder = ContextBuilder.getInstance()
  const coreToolCount = toolExecutor.getCoreToolCount()

  let systemPrompt: string
  logger.info('agent', '→ Building system prompt...')
  const promptBuildStart = Date.now()
  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride
  } else if (cmdOnlyMode && cmdCwd) {
    // userMessageText is forwarded so CMD mode can detect skill-trigger
    // hashtags (#auth-google etc.) and inline the corresponding CRITICAL
    // rules at turn 1 — same mechanism as chat mode. Without this, the
    // hashtag regex never fires in CMD and the model improvises auth from
    // training prior, producing scaffolds with placeholder credentials.
    systemPrompt = await contextBuilder.buildCmdModeSystemPrompt(cmdCwd, cmdHomeDir, mcpToolSummaries, userMessageText)
  } else {
    const projectType = currentProject?.projectType || 'unknown'
    // userMessageText carries the raw user input so contextBuilder can detect
    // skill-trigger hashtags (#auth-google etc.) and inline the corresponding
    // CRITICAL rules at turn 1.
    //
    // Intent Router: a lightweight model call (qwen3.7-plus, no tools,
    // non-streaming) classifies the user's intent into a PromptProfile + a
    // readOnly flag BEFORE the system prompt is assembled. The result feeds
    // the context builder (prompt profile + on-demand auxiliaries) and — via
    // lastAuxiliarySelection — the ToolsetSelector (bound toolset). Keeps
    // user-text inference inside the model router/planner.
    // Never throws; on failure it falls back to { bugfix_local, readOnly:false }
    // and buildSystemPrompt uses a conservative no-auxiliary fallback.
    const intentStart = Date.now()
    const intent = await classifyIntent(userMessageText ?? '')
    logger.info(
      'agent',
      `→ Intent router: profile=${intent.profile} readOnly=${intent.readOnly} (${intent.source}, ${Date.now() - intentStart}ms) — ${intent.reason}`,
    )
    systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries, coreToolCount, userMessageText, AgentService.getInstance().getAccessedFilePaths(), { profile: intent.profile, readOnly: intent.readOnly, reason: intent.reason, source: intent.source, confidence: intent.confidence, error: intent.error, diagnostics: intent.diagnostics })
  }
  logger.info('agent', `✓ System prompt built (${systemPrompt.length} chars, ${Date.now() - promptBuildStart}ms)`)

  // Get conversation history
  const rawHistory = useConversationHistory
    ? useChatStore.getState().conversationHistory
    : []
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

  let userContent: string | OpenAIContentPart[] = prompt

  const blocksForModel = modelMessageBlocks ?? userMessageBlocks
  if (hasAnyAttachments && blocksForModel) {
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
  try {
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

  // Guard against double-finalization (onDone and onError can't both finalize)
  let finalized = false

  const loopStartTime = Date.now()
  let firstTextReceived = false
  let firstReasoningReceived = false
  // Estimativas LOCAIS são apenas para o ctx-pill (chatStore) — a
  // contabilidade de billing é exclusiva do worker ai-pass-through (único
  // ponto de verdade): ele observa o `usage` real de cada resposta, aplica o
  // multiplicador do TM Speed e comita ao Firestore. O estado de billing da
  // IDE move-se pelos headers X-Budget-* de cada turno + /v1/me.
  const initialPromptEstimate = estimateTokensFromText(systemPrompt)
    + estimateTokensFromValue(history)
    + estimateTokensFromValue(userContent)
  let estimatedPromptTokens = 0
  let estimatedOutputTokens = 0
  const applyLiveTokenEstimate = (inputDelta: number, outputDelta: number) => {
    if (inputDelta > 0) estimatedPromptTokens += inputDelta
    if (outputDelta > 0) estimatedOutputTokens += outputDelta

    if (inputDelta > 0 || outputDelta > 0) {
      useChatStore.getState().addEstimatedTokenUsage(
        estimatedPromptTokens,
        estimatedOutputTokens,
      )
    }
  }

  useBillingStore.getState().resetLastRequestStats()
  applyLiveTokenEstimate(initialPromptEstimate, 0)
  logger.info('agent', '→ Agent loop starting...')

  try {
    await agentService.runAgentLoop(userContent, history, {
      onTextDelta: (delta) => {
        // After handleStop the abort controller is set; SSE chunks already
        // in flight would otherwise flip the status back to a busy state and
        // strand "A pensar..." in the title bar / status indicators.
        if (agentService.isAborted()) return
        if (!firstTextReceived) {
          firstTextReceived = true
          logger.info('agent', `✓ First text delta received (${Date.now() - loopStartTime}ms into loop)`)
        }
        agentStore.setStatus('generating')
        applyLiveTokenEstimate(0, estimateTokensFromText(delta))
        appendTextDeltaBuffered(delta)
      },
      onReasoningDelta: (delta) => {
        if (agentService.isAborted()) return
        if (!firstReasoningReceived) {
          firstReasoningReceived = true
          logger.info('agent', `✓ Reasoning started (${Date.now() - loopStartTime}ms into loop)`)
        }
        agentStore.setStatus('reasoning')
        applyLiveTokenEstimate(0, estimateTokensFromText(delta))
        appendReasoningDeltaBuffered(delta)
      },
      onReasoningComplete: () => {
        if (agentService.isAborted()) return
        // Drain the delta buffer immediately so the reasoning text is fully
        // visible before the next content (tool call / final text) starts.
        flushBufferedDeltas()
        // Mark the block boundary so the NEXT thinking block (next agent
        // loop iteration's reasoning) gets a `\n\n` prefix — without this,
        // consecutive blocks render as a single run-on paragraph.
        markReasoningBoundary()
      },
      onToolCallPending: (toolId, toolName) => {
        if (agentService.isAborted()) return
        logger.info('agent', `→ Tool call pending: ${toolName} (id: ${toolId})`)
        flushBufferedDeltas()
        agentStore.setStatus('applying')
        useChatStore.getState().addPendingToolCall(toolId, toolName)
      },
      onToolCallStart: (toolId, toolName, args) => {
        if (agentService.isAborted()) return
        const argsPreview = JSON.stringify(args).slice(0, 80)
        logger.info('agent', `→ Executing: ${toolName}(${argsPreview}...)`)
        useChatStore.getState().updateToolCallWithArgs(toolId, args)
      },
      onToolResult: (toolId, toolName, result, isError) => {
        if (agentService.isAborted()) return
        const resultLen = typeof result === 'string' ? result.length : JSON.stringify(result).length
        logger.info('agent', `✓ ${toolName} completed (${resultLen} chars${isError ? ', ERROR' : ''})`)
        useChatStore.getState().updateToolCallWithResult(toolId, result, isError)
        applyLiveTokenEstimate(estimateTokensFromValue(result), 0)
        // Tool finished — we are now waiting for the model's next response.
        agentStore.setStatus('awaiting_response')
      },
      onTurnComplete: (turnNumber, providerState) => {
        logger.info('agent', `✓ Turn ${turnNumber} complete`)
        useChatStore.getState().incrementTurnCount()
        if (providerState) {
          useChatStore.getState().setProviderState(providerState)
        }
      },
      onDone: () => {
        flushBufferedDeltas()
        if (!finalized) {
          finalized = true
          useChatStore.getState().finalizeAssistantMessage()
        }
        // Close the task tracker on a clean finish. The agent routinely ends a
        // run with its final task still `in_progress` — it does the work but
        // skips the closing update_tasks call — which strands the
        // AgentTasksPanel open on a half-finished row that never auto-hides.
        // On a successful, user-initiated, non-aborted run we flip any lingering
        // `in_progress` task to `completed`, guaranteeing the last worked task is
        // always marked done. `pending` tasks are deliberately left untouched: a
        // /plan seed is ALL-pending and onDone fires right after seeding, so
        // auto-completing those would mark an entire just-created plan as done.
        // (Aborted runs and background auto-wakes are skipped.)
        if (!isBackgroundRun && !agentService.isAborted()) {
          const tasks = useAgentStore.getState().tasks
          if (tasks.some(tk => tk.status === 'in_progress')) {
            const closed = tasks.map(tk =>
              tk.status === 'in_progress'
                ? { ...tk, status: 'completed' as const, evidence: tk.evidence || 'Run completed' }
                : tk,
            )
            useAgentStore.getState().setTasks(closed)
            const projectPath = useProjectStore.getState().currentProject?.path
            if (projectPath) {
              void import('./taskPersistence')
                .then(({ saveTasksToDisk }) => saveTasksToDisk(projectPath, closed))
                .catch(() => { /* persistence is best-effort */ })
            }
          }
        }
        agentStore.setStatus('idle')
        logger.info('agent', `✓ Agent done (total: ${Date.now() - loopStartTime}ms)`)
        useProblemsStore.getState().scanProject().catch(() => {})
        // Seasonal flourish — a successful, user-initiated run "scores" a goal
        // (World Cup 2026). Background auto-wakes pass isBackgroundRun so the
        // burst only fires on work the user actually asked for. The helper
        // itself no-ops when the seasonal feature is disabled.
        if (!isBackgroundRun) triggerGoalCelebration('agent_run_complete')
      },
      onError: (error) => {
        flushBufferedDeltas()
        resolveAllPendingDiffApprovals(false)
        agentStore.setCompactPhase('idle')
        agentStore.setStatus('error')
        agentStore.setError(error.message)
        logger.info('agent', `✗ Agent error: ${error.message}`)
        if (!finalized) {
          finalized = true
          useChatStore.getState().finalizeAssistantMessage()
        }
      },
      onUsageUpdate: (inputTokens, outputTokens, speedApplied = false) => {
        // Defensive ?? 0: partial-usage providers can pass undefined for either
        // counter; .toLocaleString() on undefined crashes the whole run.
        const inTok = inputTokens ?? 0
        const outTok = outputTokens ?? 0
        // O multiplicador real (3x por defeito) é do worker (env
        // TM_SPEED_BILLING_MULTIPLIER); o cliente não o conhece, por isso o log
        // afirma apenas que o speed foi servido — sem cravar um número que pode
        // divergir da config do worker.
        logger.info('agent', `→ Tokens: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out${speedApplied ? ' (TM Speed — billed at the server-side speed rate)' : ''}`)
        // isForeground = !isBackgroundRun: invisible auto-wake / background runs
        // still count toward billing + the activity indicator, but must NOT move
        // the ctx pill (it tracks the FOREGROUND conversation's context size).
        useChatStore.getState().addTokenUsage(inTok, outTok, !isBackgroundRun)
        // Display-only: alimenta a stat "último pedido" (ApiKeysSection).
        // A cobrança real (incl. multiplicador do TM Speed) acontece no
        // worker — nada de matemática de consumo no cliente.
        useBillingStore.getState().addLastRequestTokens(inTok + outTok)
      },
      onRequestUsage: (entry) => {
        // Persist the per-request usage log on the active session — real
        // tokens + payloadInspector estimate + breakdown. Best-effort: never
        // blocks the agent loop. Provider is enriched in the store from the
        // session's byokSnapshot (BYOK providerId, or 'tms' for data-plane).
        try { useChatStore.getState().addRequestUsage(entry) } catch { /* observability never blocks */ }
      },
      onContextCompression: (event) => {
        if (event.type === 'hooks_start') {
          agentStore.setCompactPhase(event.hookType === 'pre_compact' ? 'hooks_pre' : 'hooks_post')
        } else if (event.type === 'compact_start') {
          logger.info('agent', `⟳ Context compression starting (current: ${event.beforeTokens} tokens, trigger: ${event.trigger})...`)
          agentStore.setCompactPhase('compressing')
          agentStore.setStatus('compressing')
        } else if (event.type === 'compact_end') {
          logger.info('agent', '✓ Context compression complete')
          agentStore.setCompactPhase('idle')
          agentStore.setStatus('awaiting_response')
          useChatStore.getState().addCompactBoundaryMessage(event.beforeTokens, event.trigger, event.messagesSummarized, event.summary)
        }
      },
      // ── Queued-message steering (claude-vaz parity) ──
      // Called by the query loop at every turn boundary. Without this, a
      // message the developer queues mid-run sits in the queue until the WHOLE
      // run goes idle ("only sent when the session ends") — because the idle
      // drain (useQueueProcessor) can't fire while the guard is held. Here we
      // drain it INSIDE the live run so it rides the next turn, exactly like
      // claude-vaz. Foreground main agent only — `isBackgroundRun` covers the
      // invisible auto-wakes, and sub-agents never receive this callback.
      collectSteeringMessages: isBackgroundRun
        ? undefined
        : async (): Promise<string | null> => {
            // Only plain prompt-mode messages steer. Slash/bash/task-notif
            // commands need executeInput's per-command handling, so they stay
            // queued for the idle drain when this run ends.
            const drained = dequeueAllMatching(
              c => !isSlashCommand(c) && c.mode === 'prompt',
            )
            if (drained.length === 0) return null

            // Coalesce a burst into ONE steered turn (same as the queue's
            // batched dispatch — joinPromptValues preserves block ordering).
            const merged =
              drained.length > 1
                ? joinPromptValues(drained.map(c => c.value))
                : drained[0]!.value
            const display = extractDisplayFromValue(merged)

            const cs = useChatStore.getState()
            cs.splitForQueuedMessage(
              display.text,
              display.attachments,
              typeof merged === 'string' ? undefined : merged,
            )

            // Model-facing text. buildAugmentedPrompt resolves file/folder
            // attachments to XML; images degrade to <attached_image> markers
            // (steering is text-first — the transcript still shows the real
            // attachment, and the rare image-steer keeps its intent). @-mentions
            // are intentionally not re-resolved here.
            const text = await buildAugmentedPrompt(merged, {
              resolveAttachmentXml: resolveAttachments,
              resolveImageDataUri: resolveImageToDataUri,
            })
            return text && text.trim().length > 0 ? text : display.text
          },
    })
  } finally {
    // Always restore IDE mode regardless of how the loop exited
    if (cmdOnlyMode && cmdCwd) {
      toolExecutor.disableCmdMode()
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
