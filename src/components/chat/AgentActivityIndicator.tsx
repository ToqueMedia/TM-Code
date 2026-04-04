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
  if (count < 1_000_000) {
    const k = count / 1000
    return k >= 100 ? `${Math.round(k)}k` : k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
  }
  const m = count / 1_000_000
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
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
  const inputTokens = totalTokensUsed.input
  const outputTokens = totalTokensUsed.output
  // ↑ when sending (thinking/compressing = waiting for model), ↓ when receiving (generating/applying)
  const isSending = status === 'thinking' || status === 'compressing'

  return (
    <Flex
      align="center"
      gap="6px"
      py="8px"
      px={3}
      position="sticky"
      bottom={0}
      bg={tokens.colors.bg.app}
      zIndex={1}
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
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

      {/* Elapsed time + tokens with directional arrow */}
      <Text
        fontSize="11.5px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        whiteSpace="nowrap"
      >
        {`(${formatElapsed(elapsed)}${
          (inputTokens > 0 || outputTokens > 0)
            ? ` · ${formatTokens(inputTokens + outputTokens)}`
            : ''
        })`}
      </Text>
      {(inputTokens > 0 || outputTokens > 0) && (
        <Box
          as="span"
          fontSize="11px"
          css={{
            display: 'inline-block',
            transition: 'transform 0.3s ease, color 0.3s ease',
            transform: isSending ? 'rotate(0deg)' : 'rotate(180deg)',
            color: isSending ? tokens.colors.accent.orange : tokens.colors.accent.greenBright,
          }}
        >{'\u2191'}</Box>
      )}
    </Flex>
  )
}

export default memo(AgentActivityIndicator)
