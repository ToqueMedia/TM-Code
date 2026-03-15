import { memo, useRef, useEffect, useCallback } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiMessageSquare } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import DiffService from '../../services/agent/diffService'
import MessageBubble from './MessageBubble'
import ChatSkeleton from './ChatSkeleton'
import AgentStatusBar from './AgentStatusBar'
import PromptInput from './PromptInput'
import DiffPreview from './DiffPreview'
import { tokens } from '@/theme/tokens'

function ChatPanel() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const pendingDiffs = useChatStore(s => s.pendingDiffs)
  const scrollRef = useRef<HTMLDivElement>(null)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  // Auto-scroll to bottom when messages change or during streaming (debounced via rAF)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const rafId = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(rafId)
  }, [messages, messages.length])

  const handleAcceptDiff = useCallback(async (diffId: string) => {
    const diffService = DiffService.getInstance()
    await diffService.acceptDiff(diffId)
    useChatStore.getState().removePendingDiff(diffId)
  }, [])

  const handleRejectDiff = useCallback((diffId: string) => {
    const diffService = DiffService.getInstance()
    diffService.rejectDiff(diffId)
    useChatStore.getState().removePendingDiff(diffId)
  }, [])

  const handleAcceptAll = useCallback(async () => {
    const diffService = DiffService.getInstance()
    await diffService.acceptAllDiffs()
    useChatStore.getState().clearPendingDiffs()
  }, [])

  const handleRejectAll = useCallback(() => {
    const diffService = DiffService.getInstance()
    diffService.rejectAllDiffs()
    useChatStore.getState().clearPendingDiffs()
  }, [])

  const activeDiffs = pendingDiffs.filter(d => d.status === 'pending')

  return (
    <Flex
      direction="column"
      flex="1"
      minW="400px"
      bg={tokens.colors.bg.app}
      borderRight={`1px solid ${tokens.colors.border.default}`}
      height="100%"
    >
      {/* Message List */}
      <Box
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        flex="1"
        overflowY="auto"
        py={3}
      >
        {isLoadingSession ? (
          <ChatSkeleton />
        ) : messages.length === 0 ? (
          <Flex
            direction="column"
            align="center"
            justify="center"
            height="100%"
            p={8}
            gap={3}
          >
            <Box
              transform="translateY(0px)"
              transition="transform 0.3s ease"
              _hover={{ transform: 'translateY(-5px)' }}
            >
              <FiMessageSquare
                size={48}
                color={tokens.colors.accent.primary}
                style={{ filter: `drop-shadow(0 0 15px ${tokens.colors.accent.primaryMuted})` }}
              />
            </Box>
            <Text fontSize="lg" color={tokens.colors.text.primary} fontWeight="600">
              ToqueMedia Studio AI
            </Text>
            <Text fontSize="sm" color={tokens.colors.text.subtle} textAlign="center" maxW="320px">
              Ask me to help with your code. I can create files, explain code, fix bugs, and more.
            </Text>
          </Flex>
        ) : (
          messages.map(msg => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isStreaming={msg.id === streamingMessageId}
            />
          ))
        )}
      </Box>

      {/* Pending Diffs */}
      {activeDiffs.length > 0 && (
        <Box
          borderTop={`1px solid ${tokens.colors.border.default}`}
          bg={tokens.colors.bg.dark}
          px={3}
          py={3}
          maxH="40vh"
          overflowY="auto"
        >
          <Flex align="center" justify="space-between" mb={2}>
            <Text fontSize="xs" color={tokens.colors.text.primary} fontWeight="600">
              Pending changes ({activeDiffs.length})
            </Text>
            <Flex gap={2}>
              <button
                onClick={handleRejectAll}
                style={{
                  padding: '3px 8px',
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.accent.redMuted}`,
                  borderRadius: '4px',
                  color: tokens.colors.accent.red,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Reject All
              </button>
              <button
                onClick={handleAcceptAll}
                style={{
                  padding: '3px 8px',
                  background: tokens.colors.accent.greenSubtle,
                  border: `1px solid ${tokens.colors.accent.greenMuted}`,
                  borderRadius: '4px',
                  color: tokens.colors.accent.green,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Accept All
              </button>
            </Flex>
          </Flex>

          {activeDiffs.map(diff => (
            <DiffPreview
              key={diff.id}
              diff={diff}
              onAccept={handleAcceptDiff}
              onReject={handleRejectDiff}
            />
          ))}
        </Box>
      )}

      {/* Agent Status Bar */}
      <AgentStatusBar />

      {/* Prompt Input */}
      <PromptInput />
    </Flex>
  )
}

export default memo(ChatPanel)
