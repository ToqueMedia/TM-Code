import { memo, useState, useEffect } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}K`
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${sec}s`
}

const statusConfig: Record<string, { color: string; label: string }> = {
  idle: { color: tokens.colors.text.disabled, label: 'Ready' },
  thinking: { color: tokens.colors.toolCall.runningText, label: 'Thinking...' },
  generating: { color: tokens.colors.accent.primary, label: 'Generating...' },
  applying: { color: tokens.colors.accent.green, label: 'Applying changes...' },
  error: { color: tokens.colors.accent.red, label: 'Error' },
}

interface GeneratingStatusBarProps {
  status: string
  isStreaming: boolean
  totalTokens: number
  currentTurnCount: number
  /** Milliseconds when the agent loop started (null when idle) */
  agentStartTime: number | null
}

function GeneratingStatusBar({ status, isStreaming, totalTokens, currentTurnCount, agentStartTime }: GeneratingStatusBarProps) {
  const config = statusConfig[status] || statusConfig.idle
  const [elapsed, setElapsed] = useState(0)

  // Update elapsed time every second while streaming
  useEffect(() => {
    if (!agentStartTime) {
      setElapsed(0)
      return
    }
    setElapsed(Date.now() - agentStartTime)
    const interval = setInterval(() => {
      setElapsed(Date.now() - (agentStartTime ?? Date.now()))
    }, 1000)
    return () => clearInterval(interval)
  }, [agentStartTime])

  return (
    <Flex
      align="center"
      justify="space-between"
      px={3}
      py="6px"
      bg="rgba(255, 255, 255, 0.02)"
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
      flexShrink={0}
    >
      <Flex align="center" gap={2}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={config.color}
          css={isStreaming ? {
            animation: 'genPulse 1.5s ease-in-out infinite',
            '@keyframes genPulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.3 },
            }
          } : undefined}
        />
        <Text fontSize="11px" color={tokens.colors.text.muted} letterSpacing="0.01em">
          {config.label}
        </Text>
      </Flex>
      <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
        {formatTokens(totalTokens)} tokens · {currentTurnCount} steps{elapsed > 0 ? ` · ${formatElapsed(elapsed)}` : ''}
      </Text>
    </Flex>
  )
}

export default memo(GeneratingStatusBar)
