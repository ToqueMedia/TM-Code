import { memo } from 'react'
import { Flex, Text, Box } from '@chakra-ui/react'
import { FiSquare } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { usePermissionStore } from '../../stores/permissionStore'
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
    usePermissionStore.getState().clearPending()
    resolveAllPendingDiffApprovals(false)
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }

  const statusConfig: Record<string, { color: string; label: string; pulse: boolean }> = {
    idle: { color: tokens.colors.text.disabled, label: 'Ready', pulse: false },
    thinking: { color: tokens.colors.toolCall.runningText, label: 'Thinking...', pulse: true },
    generating: { color: tokens.colors.accent.primary, label: 'Generating...', pulse: true },
    applying: { color: tokens.colors.accent.green, label: 'Applying changes...', pulse: true },
    compressing: { color: tokens.colors.accent.orange, label: 'Compressing context...', pulse: true },
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
      py="6px"
      bg="rgba(255, 255, 255, 0.02)"
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
      minH="28px"
    >
      <Flex align="center" gap={2}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={config.color}
          flexShrink={0}
          animation={config.pulse ? 'statusPulse 1.5s ease-in-out infinite' : undefined}
          css={config.pulse ? {
            '@keyframes statusPulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.3 },
            }
          } : undefined}
        />
        <Text fontSize="11px" color={tokens.colors.text.muted} letterSpacing="0.01em">
          {config.label}
        </Text>
      </Flex>

      <Flex align="center" gap={3}>
        <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
          {formatTokens(totalTokens)} tokens · {currentTurnCount} turns
        </Text>

        {isStreaming && (
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="20px"
            h="20px"
            borderRadius="5px"
            bg="transparent"
            color={tokens.colors.accent.red}
            cursor="pointer"
            transition="all 0.12s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.1)' }}
            _active={{ transform: 'scale(0.9)' }}
            onClick={handleStop}
            aria-label="Stop generation"
          >
            <FiSquare size={11} />
          </Box>
        )}
      </Flex>
    </Flex>
  )
}

export default memo(AgentStatusBar)
