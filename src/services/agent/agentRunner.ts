import { invoke } from '@tauri-apps/api/core'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { useBillingStore } from '../../stores/billingStore'
import AgentService from './agentService'
import type { OpenAIContentPart } from './agentService'
import ContextBuilder from './contextBuilder'
import ToolExecutor from './toolExecutor'
import MCPService from '../mcp/mcpService'
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

  // Add user message to chat (with optional attachments and block order)
  if (addUserMessage) {
    chatStore.addUserMessage(
      userMessageText || prompt,
      userMessageAttachments,
      userMessageBlocks,
    )
  }

  // Start assistant message
  chatStore.startAssistantMessage()
  agentStore.setStatus('thinking')

  // Refresh MCP tools before building prompt (handles mid-session server changes)
  const mcpService = MCPService.getInstance()
  const mcpTools = mcpService.getAllTools()
  const toolExecutor = ToolExecutor.getInstance()
  if (mcpTools.length > 0) {
    toolExecutor.registerMCPTools(mcpTools, (serverName, toolName, args) =>
      mcpService.callTool(serverName, toolName, args)
    )
    AgentService.getInstance().refreshTools()
  }

  // Enable CLI mode on the executor — direct disk writes, CWD-scoped path validation.
  // Always paired with disableCmdMode() in the finally block below.
  if (cmdOnlyMode && cmdCwd) {
    toolExecutor.enableCmdMode(cmdCwd)
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
  if (cmdOnlyMode && cmdCwd) {
    systemPrompt = await contextBuilder.buildCmdModeSystemPrompt(cmdCwd, cmdHomeDir, mcpToolSummaries)
  } else {
    const projectType = currentProject?.projectType || 'unknown'
    systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries, coreToolCount)
  }

  // Get conversation history
  const rawHistory = useConversationHistory
    ? useChatStore.getState().conversationHistory
    : []

  const agentService = AgentService.getInstance()
  agentService.setSystemPrompt(systemPrompt)

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
  }

  const history = supportsMultimodal
    ? rawHistory
    : downgradeHistoryToText(rawHistory)

  // Guard against double-finalization (onDone and onError can't both finalize)
  let finalized = false

  try {
    await agentService.runAgentLoop(userContent, history, {
      onTextDelta: (delta) => {
        agentStore.setStatus('generating')
        appendTextDeltaBuffered(delta)
      },
      onReasoningDelta: (delta) => {
        agentStore.setStatus('thinking')
        appendReasoningDeltaBuffered(delta)
      },
      onToolCallPending: (toolId, toolName) => {
        flushBufferedDeltas()
        agentStore.setStatus('applying')
        useChatStore.getState().addPendingToolCall(toolId, toolName)
      },
      onToolCallStart: (toolId, _toolName, args) => {
        useChatStore.getState().updateToolCallWithArgs(toolId, args)
      },
      onToolResult: (toolId, _toolName, result, isError) => {
        useChatStore.getState().updateToolCallWithResult(toolId, result, isError)
        agentStore.setStatus('thinking')
      },
      onTurnComplete: () => {
        useChatStore.getState().incrementTurnCount()
      },
      onDone: () => {
        flushBufferedDeltas()
        if (!finalized) {
          finalized = true
          useChatStore.getState().finalizeAssistantMessage()
        }
        agentStore.setStatus('idle')
        useProblemsStore.getState().scanProject().catch(() => {})
      },
      onError: (error) => {
        flushBufferedDeltas()
        resolveAllPendingDiffApprovals(false)
        agentStore.setStatus('error')
        agentStore.setError(error.message)
        if (!finalized) {
          finalized = true
          useChatStore.getState().finalizeAssistantMessage()
        }
      },
      onUsageUpdate: (inputTokens, outputTokens) => {
        useChatStore.getState().addTokenUsage(inputTokens, outputTokens)
      },
    })
  } finally {
    // Always restore IDE mode regardless of how the loop exited
    if (cmdOnlyMode && cmdCwd) {
      toolExecutor.disableCmdMode()
    }
  }
}
