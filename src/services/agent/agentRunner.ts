import { invoke } from '@/utils/invokeMetrics'
import { logger } from '@/utils/logger'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, markReasoningBoundary, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { useBillingStore } from '../../stores/billingStore'
import AgentService from './agentService'
import type { OpenAIContentPart } from './agentService'
import ContextBuilder from './contextBuilder'
import ToolExecutor from './toolExecutor'
import MCPService from '../mcp/mcpService'
import { browserSession } from '../browserSessionManager'
import { resolveAttachments, resolveImageToDataUri, extractAndResolveMentions } from '../attachmentService'
import { buildAugmentedPrompt, buildContentParts, downgradeHistoryToText } from './promptValueHelpers'
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
 * Shared agent invocation — wires up all the chatStore/agentStore callbacks.
 * Used by both PromptInput.handleSend and slash command handlers.
 */
export async function runAgentWithCallbacks(
  prompt: string,
  options: RunAgentOptions = {}
): Promise<void> {
  const prev = lastRun
  const run = (async () => {
    // Swallow prior errors — one failed turn must not starve the queue.
    try { await prev } catch { /* ignore */ }
    await runAgentInternal(prompt, options)
  })()
  // Store a never-rejecting version so the next caller's `await prev` never throws.
  lastRun = run.catch(() => {})
  return run
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
    useConversationHistory = false,
    cmdOnlyMode = false,
    skipStartAssistantMessage = false,
    systemPromptOverride,
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
  // Path: <project>/.toquemedia/sessions/<sessionId>.large-results/
  if (currentProject?.path) {
    const { useChatStore } = await import('../../stores/chatStore')
    const sessionId = useChatStore.getState().activeSessionId
    if (sessionId) {
      const dir = `${currentProject.path}/.toquemedia/sessions/${sessionId}.large-results`
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
    systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries, coreToolCount, userMessageText, AgentService.getInstance().getAccessedFilePaths())
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

  if (hasAnyAttachments && userMessageBlocks) {
    const imageCount = userMessageAttachments?.filter(a => a.type === 'image').length ?? 0
    const fileCount = (userMessageAttachments?.length ?? 0) - imageCount
    logger.info('agent', `→ Processing attachments (${imageCount} images, ${fileCount} files)...`)
    const attachStart = Date.now()
    const promptResolvers = {
      resolveMentions: extractAndResolveMentions,
      resolveAttachmentXml: resolveAttachments,
      resolveImageDataUri: resolveImageToDataUri,
    }

    // Multimodal path — only when there are actual images AND the plan supports it.
    if (hasImageAttachments && supportsMultimodal) {
      const parts = await buildContentParts(userMessageBlocks, projectPath, promptResolvers)
      if (parts) userContent = parts
    }

    // Text fallback — handles file/folder attachments (resolveAttachmentXml)
    // AND image placeholders when multimodal isn't available or failed.
    if (typeof userContent === 'string') {
      userContent = await buildAugmentedPrompt(userMessageBlocks, projectPath, promptResolvers)
    }
    logger.info('agent', `✓ Content parts built (${Date.now() - attachStart}ms)`)
  }

  const history = supportsMultimodal
    ? rawHistory
    : downgradeHistoryToText(rawHistory)

  // Guard against double-finalization (onDone and onError can't both finalize)
  let finalized = false

  const loopStartTime = Date.now()
  let firstTextReceived = false
  let firstReasoningReceived = false
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
        appendTextDeltaBuffered(delta)
      },
      onReasoningDelta: (delta) => {
        if (agentService.isAborted()) return
        if (!firstReasoningReceived) {
          firstReasoningReceived = true
          logger.info('agent', `✓ Reasoning started (${Date.now() - loopStartTime}ms into loop)`)
        }
        agentStore.setStatus('reasoning')
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
        // Tool finished — we are now waiting for the model's next response.
        agentStore.setStatus('awaiting_response')
      },
      onTurnComplete: () => {
        logger.info('agent', '✓ Turn complete')
        useChatStore.getState().incrementTurnCount()
      },
      onDone: () => {
        flushBufferedDeltas()
        if (!finalized) {
          finalized = true
          useChatStore.getState().finalizeAssistantMessage()
        }
        agentStore.setStatus('idle')
        logger.info('agent', `✓ Agent done (total: ${Date.now() - loopStartTime}ms)`)
        useProblemsStore.getState().scanProject().catch(() => {})
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
      onUsageUpdate: (inputTokens, outputTokens) => {
        logger.info('agent', `→ Tokens: ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out`)
        useChatStore.getState().addTokenUsage(inputTokens, outputTokens)
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
          useChatStore.getState().addCompactBoundaryMessage(event.beforeTokens, event.trigger, event.messagesSummarized)
        }
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
  }
}
