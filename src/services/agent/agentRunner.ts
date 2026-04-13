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
  } = options

  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  const currentProject = useProjectStore.getState().currentProject

  // Ensure session exists
  let sessionId = chatStore.activeSessionId
  if (!sessionId) {
    sessionId = chatStore.createSession(currentProject?.path || '')
  }

  // Add user message to chat
  if (addUserMessage) {
    chatStore.addUserMessage(userMessageText || prompt)
  }

  // Start assistant message
  chatStore.startAssistantMessage()
  agentStore.setStatus('thinking')

  // Refresh MCP tools before building prompt (handles mid-session server changes)
  const projectPath = currentProject?.path || ''
  const mcpService = MCPService.getInstance()
  const mcpTools = mcpService.getAllTools()
  if (mcpTools.length > 0) {
    const toolExecutor = ToolExecutor.getInstance()
    toolExecutor.registerMCPTools(mcpTools, (serverName, toolName, args) =>
      mcpService.callTool(serverName, toolName, args)
    )
    AgentService.getInstance().refreshTools()
  }

  // Build system prompt with MCP tool info
  const projectType = currentProject?.projectType || 'unknown'
  const mcpToolSummaries = mcpTools.map(t => ({
    name: t.name,
    description: t.description,
    serverName: t.serverName,
  }))
  const contextBuilder = ContextBuilder.getInstance()
  const coreToolCount = ToolExecutor.getInstance().getCoreToolCount()
  const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries, coreToolCount)

  // Get conversation history
  const history = useConversationHistory
    ? useChatStore.getState().conversationHistory
    : []

  const agentService = AgentService.getInstance()
  agentService.setSystemPrompt(systemPrompt)

  // Guard against double-finalization (onDone and onError can't both finalize)
  let finalized = false

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
}
