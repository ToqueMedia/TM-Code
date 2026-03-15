import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}K`
}

const statusConfig: Record<string, { color: string; label: string }> = {
  idle: { color: tokens.colors.text.subtle, label: 'Ready' },
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
      py={2}
      bg={tokens.colors.bg.panel}
      borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`}
      flexShrink={0}
    >
      <Flex align="center" gap={2}>
        <Box
          w="7px"
          h="7px"
          borderRadius="full"
          bg={config.color}
          animation={isStreaming ? 'pulse 1.5s ease-in-out infinite' : undefined}
          css={isStreaming ? {
            '@keyframes pulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.4 },
            }
          } : undefined}
        />
        <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.secondary}>
          {config.label}
        </Text>
      </Flex>
      <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
        {formatTokens(totalTokens)} tokens · Turn {currentTurnCount}
      </Text>
    </Flex>
  )
}

export default memo(GeneratingStatusBar)
