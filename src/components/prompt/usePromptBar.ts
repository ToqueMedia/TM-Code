import { useState, useCallback, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useAuthStore } from '../../stores/authStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { devServerManager } from '../../services/devServerManager'
import AgentService from '../../services/agent/agentService'
import ToolExecutor from '../../services/agent/toolExecutor'
import ContextBuilder from '../../services/agent/contextBuilder'
import MCPService from '../../services/mcp/mcpService'
import { slashCommandRegistry, type SlashCommand } from '../../services/agent/slashCommandRegistry'

export function usePromptBar() {
  const input = useChatStore(s => s.draftInput)
  const setInput = useChatStore(s => s.setDraftInput)
  const [devCommand, setDevCommand] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const runningRef = useRef(false)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyIndexRef = useRef(-1)
  const savedDraftRef = useRef('')
  const isStreaming = useChatStore(s => s.isStreaming)
  const hasPendingPermission = usePermissionStore(s => !!s.pendingPermission)
  const currentProject = useProjectStore(s => s.currentProject)
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPreviewServerRunning = useLayoutStore(s => s.isPreviewServerRunning)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const isDisabled = isStreaming || hasPendingPermission
  const hasPreview = isPreviewServerRunning || !!previewHtmlContent || !!devCommand

  // Slash command menu state
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  // Detect if project can run a dev server
  useEffect(() => {
    if (!currentProject?.path) {
      setDevCommand(null)
      return
    }

    let cancelled = false
    const projectPath = currentProject.path

    async function detect() {
      // 1. Check .toquemedia-template manifest
      try {
        const raw = await invoke<string>('read_file', { path: `${projectPath}/.toquemedia-template` })
        if (!cancelled && raw) {
          const manifest = JSON.parse(raw)
          if (manifest.devCommand) {
            setDevCommand(manifest.devCommand)
            return
          }
        }
      } catch { /* no manifest */ }

      // 2. Check package.json for "dev" or "start" script
      try {
        const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
        if (!cancelled && raw) {
          const pkg = JSON.parse(raw)
          if (pkg.scripts?.dev) {
            setDevCommand('npm run dev')
            return
          }
          if (pkg.scripts?.start) {
            setDevCommand('npm start')
            return
          }
        }
      } catch { /* no package.json */ }

      if (!cancelled) setDevCommand(null)
    }

    detect()
    return () => { cancelled = true }
  }, [currentProject?.path])

  // Auto-resize textarea (runs on every input change AND on mount so the
  // preview PromptBar gets the correct height when it mounts with existing text)
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  })

  // Preserve focus across view switches (e.g. chat → preview).
  // When the PromptBar remounts with draft text, the user was typing — refocus.
  useEffect(() => {
    const draft = useChatStore.getState().draftInput
    if (draft && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  // Slash command input handler — detect "/" prefix and filter commands
  const handleInputChange = useCallback((value: string) => {
    setInput(value)
    // Reset history navigation when user types
    historyIndexRef.current = -1
    if (value.startsWith('/') && !value.includes(' ')) {
      const commands = slashCommandRegistry.filterCommands(value.split(' ')[0])
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
    } else {
      setShowCommandMenu(false)
    }
  }, [setInput])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setInput(command.name + ' ')
    setShowCommandMenu(false)
    textareaRef.current?.focus()
  }, [setInput])

  const handleBlur = useCallback(() => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    blurTimeoutRef.current = setTimeout(() => setShowCommandMenu(false), 150)
  }, [])

  // Listen for suggestion chip inserts
  useEffect(() => {
    function handleInsert(e: Event) {
      const ce = e as CustomEvent<string>
      if (ce.detail) {
        setInput(ce.detail)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('promptbar:insert', handleInsert)
    return () => window.removeEventListener('promptbar:insert', handleInsert)
  }, [])

  const handleSend = useCallback(async () => {
    const prompt = useChatStore.getState().draftInput.trim()
    if (!prompt || useChatStore.getState().isStreaming) return
    if (usePermissionStore.getState().pendingPermission) return

    // Non-reentrant guard: prevent overlapping sends
    if (runningRef.current) return
    runningRef.current = true

    try {
      // Check authentication
      const { isAuthenticated } = useAuthStore.getState()
      if (!isAuthenticated) return

      // Reset prompt history navigation
      historyIndexRef.current = -1
      savedDraftRef.current = ''

      // Close command menu
      setShowCommandMenu(false)

      // Check if it's a slash command
      if (slashCommandRegistry.isSlashCommand(prompt)) {
        const command = slashCommandRegistry.getCommand(prompt)
        if (!command) return

        if (!command.enabled) {
          useChatStore.getState().setDraftInput('')
          useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`)
          return
        }

        const projectPath = currentProject?.path
        if (!projectPath) {
          useChatStore.getState().setDraftInput('')
          useChatStore.getState().addSystemMessage('No project open. Open a project first.')
          return
        }

        useChatStore.getState().setDraftInput('')

        // Switch to chat so the user sees the agent working
        const layout = useLayoutStore.getState()
        if (layout.viewMode !== 'chat') {
          layout.setViewMode('chat')
        }

        const args = slashCommandRegistry.getArgs(prompt)
        await command.execute(args, projectPath)
        return
      }

      let chatStore = useChatStore.getState()
      const agentStore = useAgentStore.getState()

      let sessionId = chatStore.activeSessionId
      if (!sessionId) {
        const projectPath = currentProject?.path || ''
        sessionId = await chatStore.createNewSession(projectPath)
      }

      chatStore.setDraftInput('')

      // Re-read state after potential async createNewSession to get fresh conversationHistory
      chatStore = useChatStore.getState()

      // If preview is open, switch to chat so the user sees the agent working
      const layoutStore = useLayoutStore.getState()
      if (layoutStore.viewMode === 'preview') {
        layoutStore.setViewMode('chat')
      }

      chatStore.addUserMessage(prompt)
      chatStore.startAssistantMessage()
      agentStore.setStatus('thinking')

      const projectPath = currentProject?.path || ''
      const projectType = currentProject?.projectType || 'unknown'

      // Refresh MCP tools before building prompt (handles mid-session server changes)
      const mcpService = MCPService.getInstance()
      const mcpTools = mcpService.getAllTools()
      if (mcpTools.length > 0) {
        const toolExecutor = ToolExecutor.getInstance()
        toolExecutor.registerMCPTools(mcpTools, (serverName, toolName, args) =>
          mcpService.callTool(serverName, toolName, args)
        )
        AgentService.getInstance().refreshTools()
      }

      // Build system prompt with MCP tool info for the tool_routing section
      const contextBuilder = ContextBuilder.getInstance()
      const mcpToolSummaries = mcpTools.map(t => ({
        name: t.name,
        description: t.description,
        serverName: t.serverName,
      }))
      const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries)

      const history = useChatStore.getState().conversationHistory
      const agentService = AgentService.getInstance()
      agentService.setSystemPrompt(systemPrompt)

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
        onDone: async () => {
          flushBufferedDeltas()
          useChatStore.getState().finalizeAssistantMessage()
          agentStore.setStatus('idle')

          // Re-scan project diagnostics after agent finishes
          useProblemsStore.getState().scanProject().catch(() => {})

          const layoutStore = useLayoutStore.getState()

          // If preview server is running, reload and show preview
          if (layoutStore.isPreviewServerRunning) {
            layoutStore.reloadPreview()
            layoutStore.setViewMode('preview')
            return
          }

          // If a server is already starting (e.g. postScaffoldPipeline kicked
          // it off and waitForServerReady hasn't resolved yet), don't start a
          // second one — the first will auto-transition when ready.
          if (devServerManager.isActive()) return

          // Otherwise, try to start preview if we have a dev command
          if (devCommand && currentProject?.path) {
            layoutStore.addDevServerLog(`Starting dev server (${devCommand})...`, 'info')
            try {
              await devServerManager.start(currentProject.path, devCommand)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              layoutStore.addDevServerLog(`Could not start dev server: ${msg}`, 'error')
            }
          }
        },
        onError: (error) => {
          flushBufferedDeltas()
          resolveAllPendingDiffApprovals(false)
          agentStore.setStatus('error')
          agentStore.setError(error.message)
          useChatStore.getState().finalizeAssistantMessage()
        },
        onUsageUpdate: (inputTokens, outputTokens) => {
          useChatStore.getState().addTokenUsage(inputTokens, outputTokens)
        },
        onContextCompression: (beforeTokens, signal) => {
          if (signal === 0) {
            // Compression starting
            agentStore.setStatus('compressing')
            useChatStore.getState().addSystemMessage(
              `Comprimindo contexto (${Math.round(beforeTokens / 1000)}K tokens)...`
            )
          } else if (signal === -1) {
            // Compression complete
            agentStore.setStatus('thinking')
          }
        },
      })
    } finally {
      runningRef.current = false
    }
  }, [currentProject, devCommand])

  const handleStop = useCallback(() => {
    // Clear any pending permission first — resolves the dangling Promise
    usePermissionStore.getState().clearPending()
    // Resolve any pending diff approval waits (rejects them)
    resolveAllPendingDiffApprovals(false)
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Prompt history navigation (Up/Down when menu is NOT open)
      // Only navigate history when input is empty or single-line (no newlines)
      if (!showCommandMenu && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const currentInput = useChatStore.getState().draftInput
        // Only let textarea handle cursor if user is editing multi-line text (not navigating history)
        if (currentInput.includes('\n') && historyIndexRef.current === -1) return

        const session = useChatStore.getState().getActiveSession()
        if (!session) return

        // Get user messages as history (most recent last)
        const history = session.messages
          .filter(m => m.role === 'user' && m.content.trim())
          .map(m => m.content)

        if (history.length === 0) return

        // Use raw setDraftInput to avoid triggering slash command detection
        const rawSetInput = useChatStore.getState().setDraftInput

        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (historyIndexRef.current === -1) {
            savedDraftRef.current = useChatStore.getState().draftInput
          }
          if (historyIndexRef.current < history.length - 1) {
            historyIndexRef.current++
            rawSetInput(history[history.length - 1 - historyIndexRef.current])
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (historyIndexRef.current > 0) {
            historyIndexRef.current--
            rawSetInput(history[history.length - 1 - historyIndexRef.current])
          } else if (historyIndexRef.current === 0) {
            historyIndexRef.current = -1
            rawSetInput(savedDraftRef.current)
          }
        }
        setShowCommandMenu(false)
        return
      }

      // Slash command menu navigation
      if (showCommandMenu && filteredCommands.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1
          )
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev >= filteredCommands.length - 1 ? 0 : prev + 1
          )
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault()
          const selected = filteredCommands[selectedCommandIndex]
          if (selected) handleCommandSelect(selected)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCommandMenu(false)
          return
        }
      }

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, showCommandMenu, filteredCommands, selectedCommandIndex, handleCommandSelect]
  )

  const toggleEditor = useCallback(() => {
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.viewMode === 'editor') {
      layoutStore.goBack()
    } else {
      layoutStore.setViewMode('editor')
    }
  }, [])

  const togglePreview = useCallback(async () => {
    const layoutStore = useLayoutStore.getState()

    if (layoutStore.viewMode === 'preview') {
      layoutStore.goBack()
      return
    }

    // If server is already running or static preview exists, just switch view
    if (layoutStore.isPreviewServerRunning || layoutStore.previewHtmlContent) {
      layoutStore.setViewMode('preview')
      return
    }

    // If server is already starting, don't restart
    if (devServerManager.isActive()) return

    // No server running — start one if we have a devCommand
    if (devCommand && currentProject?.path) {
      const layout = useLayoutStore.getState()
      layout.addDevServerLog(`Starting dev server (${devCommand})...`, 'info')
      try {
        await devServerManager.start(currentProject.path, devCommand)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        layout.addDevServerLog(`Could not start dev server: ${msg}`, 'error')
      }
    }
  }, [devCommand, currentProject?.path])

  return {
    input,
    setInput: handleInputChange,
    textareaRef,
    isStreaming,
    isDisabled,
    viewMode,
    hasPreview,
    handleSend,
    handleStop,
    handleKeyDown,
    handleBlur,
    toggleEditor,
    togglePreview,
    // Slash command menu
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    handleCommandSelect,
  }
}
