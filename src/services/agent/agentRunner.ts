import { invoke } from '@tauri-apps/api/core'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useProblemsStore } from '../../stores/problemsStore'
import AgentService from './agentService'
import ContextBuilder from './contextBuilder'
import ToolExecutor from './toolExecutor'
import MCPService from '../mcp/mcpService'

interface RunAgentOptions {
  /** Whether to add a user message to the chat. Default: true */
  addUserMessage?: boolean
  /** Text to show in the user bubble. Defaults to the prompt itself. */
  userMessageText?: string
  /** Use existing conversation history instead of empty. Default: false */
  useConversationHistory?: boolean
  /**
   * Run in CLI/CMD-only mode: no project required, file writes go directly to
   * disk without diff approval, CWD is the user's home directory.
   * Must be set explicitly by the caller — never derived implicitly from project state.
   */
  cmdOnlyMode?: boolean
}

/** Non-reentrancy guard — prevents overlapping agent invocations. */
let running = false

/**
 * Shared agent invocation — wires up all the chatStore/agentStore callbacks.
 * Used by both PromptInput.handleSend and slash command handlers.
 */
export async function runAgentWithCallbacks(
  prompt: string,
  options: RunAgentOptions = {}
): Promise<void> {
  if (running) return
  running = true

  try {
    await runAgentInternal(prompt, options)
  } finally {
    running = false
  }
}

async function runAgentInternal(
  prompt: string,
  options: RunAgentOptions
): Promise<void> {
  const {
    addUserMessage = true,
    userMessageText,
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

  // Add user message to chat
  if (addUserMessage) {
    chatStore.addUserMessage(userMessageText || prompt)
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
  const history = useConversationHistory
    ? useChatStore.getState().conversationHistory
    : []

  const agentService = AgentService.getInstance()
  agentService.setSystemPrompt(systemPrompt)

  // Guard against double-finalization (onDone and onError can't both finalize)
  let finalized = false

  try {
    await agentService.runAgentLoop(prompt, history, {
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
