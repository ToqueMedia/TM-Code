import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}K`
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
}

function GeneratingStatusBar({ status, isStreaming, totalTokens, currentTurnCount }: GeneratingStatusBarProps) {
  const config = statusConfig[status] || statusConfig.idle

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
        {formatTokens(totalTokens)} tokens · Turn {currentTurnCount}
      </Text>
    </Flex>
  )
}

export default memo(GeneratingStatusBar)
