import { memo, useRef, useEffect, useCallback, useState, lazy, Suspense } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiMessageSquare } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import MessageBubble from './MessageBubble'
import ChatSkeleton from './ChatSkeleton'
import AgentStatusBar from './AgentStatusBar'
import PromptInput from './PromptInput'
import { tokens } from '@/theme/tokens'

const CheckpointPanel = lazy(() => import('./CheckpointPanel'))

function ChatPanel() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const isStreaming = useChatStore(s => s.isStreaming)
  // Subscribe to streaming version changes to trigger re-renders during streaming
  useChatStore(s => s.streamingVersion)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []
  const lastMessage = messages[messages.length - 1]

  // Auto-scroll: smooth scroll to bottom during streaming (unless user scrolled up)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (!isStreaming) {
      // When not streaming, always scroll to bottom on new messages
      const rafId = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      setUserScrolledUp(false)
      return () => cancelAnimationFrame(rafId)
    }

    if (!userScrolledUp) {
      const rafId = requestAnimationFrame(() => {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth',
        })
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [messages, messages.length, lastMessage?.content, isStreaming, userScrolledUp])

  // Detect user scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!isStreaming) return
    const el = e.currentTarget
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setUserScrolledUp(!isAtBottom)
  }, [isStreaming])

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
        onScroll={handleScroll}
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
              TM Code
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

      {/* Checkpoint Panel */}
      <Suspense fallback={null}>
        <CheckpointPanel />
      </Suspense>

      {/* Agent Status Bar */}
      <AgentStatusBar />

      {/* Prompt Input */}
      <PromptInput />
    </Flex>
  )
}

export default memo(ChatPanel)
