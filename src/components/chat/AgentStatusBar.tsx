import { memo } from 'react'
import { Flex, Text, Box, IconButton } from '@chakra-ui/react'
import { FiSquare } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore } from '../../stores/chatStore'
import AgentService from '../../services/agent/agentService'
import { tokens } from '@/theme/tokens'

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}K`
}

function AgentStatusBar() {
  const status = useAgentStore(s => s.status)
  const error = useAgentStore(s => s.error)
  const isStreaming = useChatStore(s => s.isStreaming)
  const totalTokensUsed = useChatStore(s => s.totalTokensUsed)
  const currentTurnCount = useChatStore(s => s.currentTurnCount)

  const handleStop = () => {
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }

  const statusConfig: Record<string, { color: string; label: string; pulse: boolean }> = {
    idle: { color: tokens.colors.status.idle, label: 'Ready', pulse: false },
    thinking: { color: tokens.colors.status.warning, label: 'Thinking...', pulse: true },
    generating: { color: tokens.colors.accent.primary, label: 'Generating...', pulse: true },
    applying: { color: tokens.colors.accent.green, label: 'Applying changes...', pulse: true },
    error: { color: tokens.colors.accent.red, label: error || 'Error', pulse: false },
  }

  const config = statusConfig[status] || statusConfig.idle
  const totalTokens = totalTokensUsed.input + totalTokensUsed.output

  return (
    <Flex
      role="status"
      aria-live="polite"
      align="center"
      justify="space-between"
      px={3}
      py={1.5}
      bg={tokens.colors.bg.sidebar}
      borderTop={`1px solid ${tokens.colors.border.default}`}
      minH="28px"
    >
      <Flex align="center" gap={2}>
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          bg={config.color}
          flexShrink={0}
          animation={config.pulse ? 'pulse 1.5s ease-in-out infinite' : undefined}
          css={config.pulse ? {
            '@keyframes pulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.4 },
            }
          } : undefined}
        />
        <Text fontSize="xs" color={tokens.colors.text.subtle}>
          {config.label}
        </Text>
      </Flex>

      <Flex align="center" gap={3}>
        <Text fontSize="xs" color={tokens.colors.diff.lineNumber}>
          Tokens: {formatTokens(totalTokens)} | Turns: {currentTurnCount}
        </Text>

        {isStreaming && (
          <IconButton
            aria-label="Stop generation"
            size="xs"
            variant="ghost"
            color={tokens.colors.accent.red}
            _hover={{ bg: tokens.colors.accent.redSubtle }}
            onClick={handleStop}
          >
            <FiSquare size={12} />
          </IconButton>
        )}
      </Flex>
    </Flex>
  )
}

export default memo(AgentStatusBar)
