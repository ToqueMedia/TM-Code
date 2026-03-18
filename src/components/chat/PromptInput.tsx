import React, { memo, useState, useCallback, useRef, useEffect } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiSend } from 'react-icons/fi'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useAuthStore } from '../../stores/authStore'
import AgentService from '../../services/agent/agentService'
import ContextBuilder from '../../services/agent/contextBuilder'
import { useProblemsStore } from '../../stores/problemsStore'
import { tokens } from '@/theme/tokens'

function PromptInput() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStreaming = useChatStore(s => s.isStreaming)
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const currentProject = useProjectStore(s => s.currentProject)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [input])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isStreaming) return

    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) return

    const agentStore = useAgentStore.getState()

    let sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) {
      sessionId = useChatStore.getState().createSession(currentProject?.path || '')
    }

    setInput('')

    useChatStore.getState().addUserMessage(prompt)
    useChatStore.getState().startAssistantMessage()
    agentStore.setStatus('thinking')

    const projectPath = currentProject?.path || ''
    const projectType = currentProject?.projectType || 'unknown'
    const contextBuilder = ContextBuilder.getInstance()
    const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType)
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
      onDone: () => {
        flushBufferedDeltas()
        useChatStore.getState().finalizeAssistantMessage()
        agentStore.setStatus('idle')
        useProblemsStore.getState().scanProject().catch(() => {})
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

  const canSend = input.trim().length > 0 && !isStreaming

  return (
    <Box px={4} py={3} bg={tokens.colors.bg.app}>
      <Box
        borderRadius="14px"
        border="1px solid rgba(255, 255, 255, 0.08)"
        bg="rgba(255, 255, 255, 0.03)"
        overflow="hidden"
        transition="all 0.2s"
        css={{
          '&:focus-within': {
            borderColor: 'rgba(254, 16, 99, 0.35)',
            boxShadow: '0 0 0 1px rgba(254, 16, 99, 0.1), 0 4px 20px rgba(254, 16, 99, 0.06)',
          },
        }}
      >
        <Flex align="flex-end" gap={2} px={3} py="10px">
          <Box flex="1" position="relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask TM Code to help with your code..."
              aria-label="Message prompt"
              disabled={isStreaming}
              rows={1}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: tokens.colors.text.primary,
                fontSize: '13.5px',
                fontFamily: tokens.fontFamily.ui,
                resize: 'none',
                lineHeight: '24px',
                maxHeight: `${6 * 24}px`,
                overflowY: 'auto',
                opacity: isStreaming ? 0.4 : 1,
                letterSpacing: '-0.005em',
              }}
            />
          </Box>
          <Flex
            as="button"
            w="30px"
            h="30px"
            borderRadius="8px"
            bg={canSend ? tokens.gradient.accentPrimary : 'transparent'}
            align="center"
            justify="center"
            cursor={canSend ? 'pointer' : 'default'}
            transition="all 0.15s"
            flexShrink={0}
            onClick={handleSend}
            aria-disabled={!canSend}
            opacity={canSend ? 1 : 0.3}
            boxShadow={canSend ? '0 2px 10px rgba(254, 16, 99, 0.3)' : 'none'}
            _hover={canSend ? { transform: 'scale(1.05)', boxShadow: '0 4px 16px rgba(254, 16, 99, 0.4)' } : undefined}
            _active={canSend ? { transform: 'scale(0.95)' } : undefined}
          >
            <FiSend size={14} color={canSend ? '#ffffff' : tokens.colors.text.disabled} />
          </Flex>
        </Flex>

        {/* Shortcut hint */}
        <Flex
          px={3}
          py="5px"
          justify="flex-end"
          borderTop="1px solid rgba(255, 255, 255, 0.03)"
        >
          <Text fontSize="10px" color="rgba(255,255,255,0.15)" letterSpacing="0.02em">
            {navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'} + Enter to send
          </Text>
        </Flex>
      </Box>
    </Box>
  )
}

export default memo(PromptInput)
