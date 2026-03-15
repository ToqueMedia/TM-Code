import { memo, useRef, useEffect } from 'react'
import { Flex, Box } from '@chakra-ui/react'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import MessageBubble from '../chat/MessageBubble'
import ChatSkeleton from '../chat/ChatSkeleton'
import SessionDropdown from './SessionDropdown'
import ChatSuggestions from './ChatSuggestions'
import { tokens } from '@/theme/tokens'

function ChatView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const currentProject = useProjectStore(s => s.currentProject)
  const scrollRef = useRef<HTMLDivElement>(null)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []
  const projectPath = currentProject?.path || ''

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, messages.length, messages[messages.length - 1]?.content])

  return (
    <Flex
      direction="column"
      flex="1"
      overflow="hidden"
    >
      {/* Session header bar */}
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py={2}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        flexShrink={0}
        position="relative"
      >
        <SessionDropdown
          projectPath={projectPath}
          activeSessionId={activeSessionId}
          isStreaming={isStreaming}
        />
      </Flex>

      <Box
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        flex="1"
        overflowY="auto"
        css={{
          '&::-webkit-scrollbar': { width: '6px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: tokens.colors.border.panel,
            borderRadius: '3px',
          },
        }}
      >
        {isLoadingSession ? (
          <Box maxW="800px" mx="auto" w="100%" py={4} px={4}>
            <ChatSkeleton />
          </Box>
        ) : messages.length === 0 ? (
          <ChatSuggestions />
        ) : (
          <Box
            maxW="800px"
            mx="auto"
            w="100%"
            py={4}
            px={4}
          >
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={msg.id === streamingMessageId}
              />
            ))}
          </Box>
        )}
      </Box>
    </Flex>
  )
}

export default memo(ChatView)
