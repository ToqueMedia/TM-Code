import { memo, useRef, useEffect } from 'react'
import { Flex, Box, HStack, Text } from '@chakra-ui/react'
import { FiSidebar, FiZap } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useMcpStore } from '../../stores/mcpStore'
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
  // Subscribe to streaming version changes to trigger re-renders during streaming
  useChatStore(s => s.streamingVersion)
  const currentProject = useProjectStore(s => s.currentProject)
  const isProjectsSidebarVisible = useLayoutStore(s => s.isProjectsSidebarVisible)
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const scrollRef = useRef<HTMLDivElement>(null)
  const runningMcpServers = mcpServers.filter(s => s.status === 'running')

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
        <Flex align="center" gap={2}>
          {/* Toggle projects sidebar */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="28px"
            h="28px"
            borderRadius="6px"
            color={isProjectsSidebarVisible ? tokens.colors.accent.primary : tokens.colors.text.secondary}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
            onClick={() => useLayoutStore.getState().toggleProjectsSidebar()}
            aria-label="Toggle projects sidebar"
          >
            <FiSidebar size={15} />
          </Box>
          <SessionDropdown
            projectPath={projectPath}
            activeSessionId={activeSessionId}
            isStreaming={isStreaming}
          />
        </Flex>

        {/* MCP server indicators */}
        <HStack gap={1.5}>
          {mcpIsInitializing && (
            <McpPill label="MCP starting..." color={tokens.colors.accent.orange} />
          )}
          {runningMcpServers.map(server => (
            <McpPill
              key={server.name}
              label={`${server.name} (${server.tools.length})`}
              color={tokens.colors.accent.green}
            />
          ))}
          {mcpServers.filter(s => s.status === 'error').map(server => (
            <McpPill
              key={server.name}
              label={server.name}
              color={tokens.colors.accent.red}
            />
          ))}
        </HStack>
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

function McpPill(props: { label: string; color: string }) {
  return (
    <HStack
      gap={1}
      px={2}
      py="3px"
      borderRadius={tokens.radius.full}
      bg="rgba(255, 255, 255, 0.04)"
      border="1px solid"
      borderColor="rgba(255, 255, 255, 0.06)"
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
      onClick={function () { useLayoutStore.getState().setViewMode('settings') }}
    >
      <FiZap size={10} color={props.color} />
      <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
        {props.label}
      </Text>
    </HStack>
  )
}

export default memo(ChatView)
