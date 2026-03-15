import { useState, useCallback, useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useAuthStore } from '../../stores/authStore'
import { usePermissionStore } from '../../stores/permissionStore'
import AgentService from '../../services/agent/agentService'
import ContextBuilder from '../../services/agent/contextBuilder'

export function usePromptBar() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const isStreaming = useChatStore(s => s.isStreaming)
  const hasPendingPermission = usePermissionStore(s => !!s.pendingPermission)
  const currentProject = useProjectStore(s => s.currentProject)
  const viewMode = useLayoutStore(s => s.viewMode)
  const isDisabled = isStreaming || hasPendingPermission

  // Track mount state; abort agent loop on unmount
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      AgentService.getInstance().cancelLoop()
    }
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [input])

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
    const prompt = input.trim()
    if (!prompt || isStreaming) return
    if (usePermissionStore.getState().pendingPermission) return

    // Non-reentrant guard: prevent overlapping sends
    if (runningRef.current) return
    runningRef.current = true

    try {
      // Check authentication
      const { isAuthenticated } = useAuthStore.getState()
      if (!isAuthenticated) {
        // User not logged in — cannot send
        return
      }

      let chatStore = useChatStore.getState()
      const agentStore = useAgentStore.getState()

      let sessionId = chatStore.activeSessionId
      if (!sessionId) {
        const projectPath = currentProject?.path || ''
        sessionId = await chatStore.createNewSession(projectPath)
      }

      setInput('')

      // Re-read state after potential async createNewSession to get fresh conversationHistory
      chatStore = useChatStore.getState()

      chatStore.addUserMessage(prompt)
      const messageId = chatStore.startAssistantMessage()
      agentStore.setStatus('thinking')

      const projectPath = currentProject?.path || ''
      const projectType = currentProject?.projectType || 'unknown'
      const contextBuilder = ContextBuilder.getInstance()
      const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType)

      const history = useChatStore.getState().conversationHistory
      const agentService = AgentService.getInstance()
      agentService.setSystemPrompt(systemPrompt)

      await agentService.runAgentLoop(prompt, history, {
        onTextChunk: (text) => {
          if (!mountedRef.current) return
          agentStore.setStatus('generating')
          chatStore.appendToAssistantMessage(text)
        },
        onToolCall: (toolName, toolInput) => {
          if (!mountedRef.current) return
          agentStore.setStatus('applying')
          chatStore.appendToolCallToMessage(messageId, toolName, toolInput)

          // Auto-transition to generating view when writing files
          if (toolName === 'write_file') {
            const layoutStore = useLayoutStore.getState()
            if (layoutStore.viewMode === 'chat') {
              layoutStore.setViewMode('generating')
            }
          }
        },
        onToolResult: (toolName, result, isError) => {
          if (!mountedRef.current) return
          chatStore.appendToolResultToMessage(messageId, toolName, result, isError)
          agentStore.setStatus('thinking')
        },
        onTurnComplete: () => {
          if (!mountedRef.current) return
          chatStore.incrementTurnCount()
        },
        onDone: () => {
          if (!mountedRef.current) return
          chatStore.finalizeAssistantMessage()
          agentStore.setStatus('idle')

          // If no pending diffs and we're in generating view, go back to chat
          const layoutStore = useLayoutStore.getState()
          const pendingDiffs = useChatStore.getState().pendingDiffs.filter(d => d.status === 'pending')
          if (layoutStore.viewMode === 'generating' && pendingDiffs.length === 0) {
            if (layoutStore.isPreviewServerRunning) {
              layoutStore.setViewMode('preview')
            } else {
              layoutStore.setViewMode('chat')
            }
          }
        },
        onError: (error) => {
          if (!mountedRef.current) return
          agentStore.setStatus('error')
          agentStore.setError(error.message)
          chatStore.finalizeAssistantMessage()
        },
        onUsageUpdate: (inputTokens, outputTokens) => {
          if (!mountedRef.current) return
          chatStore.addTokenUsage(inputTokens, outputTokens)
        },
      })
    } finally {
      runningRef.current = false
    }
  }, [input, isStreaming, currentProject])

  const handleStop = useCallback(() => {
    // Clear any pending permission first — resolves the dangling Promise
    usePermissionStore.getState().clearPending()
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const toggleEditor = useCallback(() => {
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.viewMode === 'editor') {
      layoutStore.goBack()
    } else {
      layoutStore.setViewMode('editor')
    }
  }, [])

  return {
    input,
    setInput,
    textareaRef,
    isStreaming,
    isDisabled,
    viewMode,
    handleSend,
    handleStop,
    handleKeyDown,
    toggleEditor,
  }
}
