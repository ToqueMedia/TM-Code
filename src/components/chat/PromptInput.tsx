import React, { memo, useState, useCallback, useRef, useEffect } from 'react'
import { Flex, Box, IconButton } from '@chakra-ui/react'
import { FiSend } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useAuthStore } from '../../stores/authStore'
import AgentService from '../../services/agent/agentService'
import ContextBuilder from '../../services/agent/contextBuilder'
import { tokens } from '@/theme/tokens'

function PromptInput() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useRef(true)
  const isStreaming = useChatStore(s => s.isStreaming)
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const currentProject = useProjectStore(s => s.currentProject)

  // Track mount state for async cleanup
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
    const maxHeight = 6 * 24 // ~6 lines
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [input])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isStreaming) return

    // Check authentication
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) return

    const chatStore = useChatStore.getState()
    const agentStore = useAgentStore.getState()

    // Ensure session exists
    let sessionId = chatStore.activeSessionId
    if (!sessionId) {
      sessionId = chatStore.createSession(currentProject?.path || '')
    }

    setInput('')

    // Add user message
    chatStore.addUserMessage(prompt)

    // Start assistant message
    const messageId = chatStore.startAssistantMessage()
    agentStore.setStatus('thinking')

    // Build context
    const projectPath = currentProject?.path || ''
    const projectType = currentProject?.projectType || 'unknown'
    const contextBuilder = ContextBuilder.getInstance()
    const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType)

    // Get conversation history
    const history = chatStore.conversationHistory

    // Configure agent
    const agentService = AgentService.getInstance()
    agentService.setSystemPrompt(systemPrompt)

    // Run agentic loop with mounted guard on callbacks
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
  }, [input, isStreaming, activeSessionId, currentProject])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <Box px={3} py={2} bg={tokens.colors.bg.app} borderTop={`1px solid ${tokens.colors.border.default}`}>
      <Flex
        align="flex-end"
        gap={2}
        bg={tokens.colors.bg.sidebar}
        borderRadius="8px"
        border={`1px solid ${tokens.colors.border.default}`}
        px={3}
        py={2}
        _focusWithin={{
          borderColor: tokens.colors.accent.primaryFocus,
        }}
        transition="border-color 0.2s"
      >
        <Box flex="1" position="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the agent to help with your code..."
            aria-label="Message prompt"
            disabled={isStreaming}
            rows={1}
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: tokens.colors.text.primary,
              fontSize: '13px',
              fontFamily: tokens.fontFamily.ui,
              resize: 'none',
              lineHeight: '24px',
              maxHeight: `${6 * 24}px`,
              overflowY: 'auto',
              opacity: isStreaming ? 0.5 : 1,
            }}
          />
        </Box>
        <IconButton
          aria-label="Send message"
          size="sm"
          variant="ghost"
          color={input.trim() && !isStreaming ? tokens.colors.accent.primary : tokens.colors.text.subtle}
          _hover={{
            bg: input.trim() && !isStreaming ? tokens.colors.accent.primarySubtle : 'transparent',
          }}
          onClick={handleSend}
          disabled={!input.trim() || isStreaming}
          flexShrink={0}
        >
          <FiSend size={16} />
        </IconButton>
      </Flex>
    </Box>
  )
}

export default memo(PromptInput)
