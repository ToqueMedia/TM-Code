import { memo, useRef, useEffect, useCallback, useState } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiPlus, FiClock, FiChevronDown } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { SessionSummary } from '../../types/chat'
import { tokens } from '@/theme/tokens'

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

interface SessionDropdownProps {
  projectPath: string
  activeSessionId: string | null
  isStreaming: boolean
}

function SessionDropdown({ projectPath, activeSessionId, isStreaming }: SessionDropdownProps) {
  const [showSessions, setShowSessions] = useState(false)
  const [sessionList, setSessionList] = useState<SessionSummary[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const sessionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showSessions) return
    function handleClick(e: MouseEvent) {
      if (sessionsRef.current && !sessionsRef.current.contains(e.target as Node)) {
        setShowSessions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSessions])

  const handleNewChat = useCallback(async () => {
    if (!projectPath || isStreaming) return
    await useChatStore.getState().createNewSession(projectPath)
  }, [projectPath, isStreaming])

  const handleToggleSessions = useCallback(async () => {
    if (!projectPath || loadingSessions) return
    if (!showSessions) {
      setLoadingSessions(true)
      try {
        const list = await useChatStore.getState().listProjectSessions(projectPath)
        setSessionList(list)
      } finally {
        setLoadingSessions(false)
      }
    }
    setShowSessions(prev => !prev)
  }, [projectPath, showSessions, loadingSessions])

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    if (!projectPath || isStreaming) return
    setShowSessions(false)
    await useChatStore.getState().switchSession(projectPath, sessionId)
  }, [projectPath, isStreaming])

  return (
    <Flex align="center" gap={2}>
      {/* New Chat button */}
      <Box
        as="button"
        aria-label="New Chat"
        display="flex"
        alignItems="center"
        gap="6px"
        px={2.5}
        py={1.5}
        bg="transparent"
        border={`1px solid ${tokens.colors.border.panel}`}
        borderRadius="8px"
        color={tokens.colors.text.secondary}
        fontSize={tokens.fontSize.sm}
        cursor={isStreaming ? 'not-allowed' : 'pointer'}
        opacity={isStreaming ? 0.5 : 1}
        transition={`all ${tokens.transition.fast}`}
        _hover={!isStreaming ? {
          bg: tokens.colors.bg.panel,
          borderColor: tokens.colors.accent.primary,
          color: tokens.colors.text.primary
        } : {}}
        onClick={handleNewChat}
      >
        <FiPlus size={13} />
        New Chat
      </Box>

      {/* Sessions dropdown */}
      <Box position="relative" ref={sessionsRef}>
        <Box
          as="button"
          aria-label="Toggle sessions list"
          aria-expanded={showSessions}
          aria-haspopup="listbox"
          display="flex"
          alignItems="center"
          gap="6px"
          px={2.5}
          py={1.5}
          bg="transparent"
          border={`1px solid ${tokens.colors.border.panel}`}
          borderRadius="8px"
          color={tokens.colors.text.secondary}
          fontSize={tokens.fontSize.sm}
          cursor="pointer"
          transition={`all ${tokens.transition.fast}`}
          _hover={{
            bg: tokens.colors.bg.panel,
            borderColor: tokens.colors.accent.primary,
            color: tokens.colors.text.primary
          }}
          onClick={handleToggleSessions}
        >
          <FiClock size={13} />
          Sessions
          <FiChevronDown size={11} />
        </Box>

        {showSessions && (
          <Box
            role="listbox"
            aria-label="Chat sessions"
            position="absolute"
            top="100%"
            left={0}
            mt={1}
            minW="280px"
            maxH="300px"
            overflowY="auto"
            bg={tokens.colors.bg.panel}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="10px"
            boxShadow={tokens.shadow.panel}
            zIndex={tokens.zIndex.dropdown}
            py={1}
            css={{
              '&::-webkit-scrollbar': { width: '4px' },
              '&::-webkit-scrollbar-thumb': { background: tokens.colors.border.panel, borderRadius: '2px' },
            }}
          >
            {sessionList.length === 0 ? (
              <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.disabled} px={3} py={2}>
                No sessions yet
              </Text>
            ) : (
              sessionList.map(s => (
                <Box
                  key={s.id}
                  as="button"
                  role="option"
                  aria-selected={s.id === activeSessionId}
                  display="block"
                  w="100%"
                  textAlign="left"
                  px={3}
                  py={2}
                  cursor="pointer"
                  bg={s.id === activeSessionId ? tokens.colors.accent.primarySubtle : 'transparent'}
                  transition={`background ${tokens.transition.fast}`}
                  _hover={{
                    bg: s.id === activeSessionId
                      ? tokens.colors.accent.primaryHover
                      : tokens.colors.bg.panelAlt
                  }}
                  onClick={() => handleSwitchSession(s.id)}
                >
                  <Flex justify="space-between" align="center" mb={0.5}>
                    <Text
                      fontSize={tokens.fontSize.sm}
                      fontWeight={s.id === activeSessionId ? '600' : '400'}
                      color={s.id === activeSessionId ? tokens.colors.accent.primary : tokens.colors.text.primary}
                      lineClamp={1}
                    >
                      {s.lastMessage || 'Empty session'}
                    </Text>
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} flexShrink={0} ml={2}>
                      {formatRelativeTime(s.updatedAt)}
                    </Text>
                  </Flex>
                  <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                    {s.messageCount} messages
                  </Text>
                </Box>
              ))
            )}
          </Box>
        )}
      </Box>
    </Flex>
  )
}

export default memo(SessionDropdown)
