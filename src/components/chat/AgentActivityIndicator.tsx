import { memo, useState, useEffect, useRef } from 'react'
import { Flex, Text, Box } from '@chakra-ui/react'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}k`
}

const STATUS_LABELS: Record<string, string> = {
  thinking: 'Thinking',
  generating: 'Writing',
  applying: 'Applying changes',
  compressing: 'Compressing context',
}

function AgentActivityIndicator() {
  const status = useAgentStore(s => s.status)
  const isStreaming = useChatStore(s => s.isStreaming)
  const totalTokensUsed = useChatStore(s => s.totalTokensUsed)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)
  const prevStreamingRef = useRef(false)

  // Start/reset timer when streaming begins
  useEffect(() => {
    if (isStreaming) {
      startRef.current = Date.now()
      setElapsed(0)
      const interval = setInterval(() => {
        setElapsed(Date.now() - startRef.current)
      }, 1000)
      return () => clearInterval(interval)
    }
  }, [isStreaming])

  // When streaming ends, add "Worked for Xm Ys" system message
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && startRef.current > 0) {
      const finalElapsed = Date.now() - startRef.current
      if (finalElapsed > 2000) {
        useChatStore.getState().addSystemMessage(`Trabalhou por ${formatElapsed(finalElapsed)}`)
      }
      startRef.current = 0
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  if (!isStreaming) return null

  const label = STATUS_LABELS[status] || 'Working'
  const outputTokens = totalTokensUsed.output

  return (
    <Flex
      align="center"
      gap="6px"
      py="10px"
      px={1}
    >
      {/* Pulsing dot */}
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={tokens.colors.accent.primary}
        flexShrink={0}
        css={{
          animation: 'activityPulse 1.5s ease-in-out infinite',
          '@keyframes activityPulse': {
            '0%, 100%': { opacity: 1 },
            '50%': { opacity: 0.25 },
          },
        }}
      />

      {/* Status label */}
      <Text
        fontSize="12.5px"
        color={tokens.colors.text.muted}
        letterSpacing="-0.005em"
      >
        {label}
        <Box
          as="span"
          css={{
            '&::after': {
              content: '"..."',
              animation: 'dots 1.4s steps(4, end) infinite',
            },
            '@keyframes dots': {
              '0%': { content: '""' },
              '25%': { content: '"."' },
              '50%': { content: '".."' },
              '75%': { content: '"..."' },
            },
          }}
        />
      </Text>

      {/* Elapsed time + tokens */}
      <Text
        fontSize="11.5px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
      >
        ({formatElapsed(elapsed)}
        {outputTokens > 0 && ` · ${formatTokens(outputTokens)} tokens`})
      </Text>
    </Flex>
  )
}

export default memo(AgentActivityIndicator)
