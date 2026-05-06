import { memo, lazy, Suspense } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiMessageSquare } from 'react-icons/fi'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import MessageBubble from './MessageBubble'
import ChatSkeleton from './ChatSkeleton'
import AgentStatusBar from './AgentStatusBar'
import PromptBar from '../PromptBar'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const CheckpointPanel = lazy(() => import('./CheckpointPanel'))

function ChatPanel() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  // streamingVersion must be subscribed — it's the ONLY selector that triggers
  // re-renders during streaming (messages are mutated in-place for performance).
  useChatStore(s => s.streamingVersion)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  const { scrollRef, contentRef } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

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
        aria-label={t("chat.messages")}
        flex="1"
        overflowY="auto"
        py={3}
      >
        <Box ref={contentRef} minH="100%">
          {isLoadingSession ? (
            <ChatSkeleton />
          ) : messages.length === 0 ? (
            <Flex
              direction="column"
              align="center"
              justify="center"
              minH="100%"
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
      </Box>

      {/* Checkpoint Panel */}
      <Suspense fallback={null}>
        <CheckpointPanel />
      </Suspense>

      {/* Agent Status Bar */}
      <AgentStatusBar />

      {/* Prompt bar — full-featured (queue, attachments, slash/mention/hashtag,
          history, BYOK indicator). Same component used by MainLayout and
          PreviewView so behaviour stays consistent across surfaces. */}
      <PromptBar />
    </Flex>
  )
}

export default memo(ChatPanel)
