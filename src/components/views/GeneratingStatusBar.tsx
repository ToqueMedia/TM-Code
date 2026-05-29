import { memo, useState, useEffect, type ReactNode } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiArrowDown, FiArrowUp } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

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

interface GeneratingStatusBarProps {
  status: string
  isStreaming: boolean
  /** Context size on the wire (last turn's full prompt size — ratchets up). */
  inputTokens: number
  /** Total tokens emitted by the model across all turns of this request. */
  outputTokens: number
  currentTurnCount: number
  /** Milliseconds when the agent loop started (null when idle) */
  agentStartTime: number | null
}

function GeneratingStatusBar({ status, isStreaming, inputTokens, outputTokens, currentTurnCount, agentStartTime }: GeneratingStatusBarProps) {
  const statusConfig: Record<string, { color: string; label: string }> = {
    idle: { color: tokens.colors.text.disabled, label: t('generating.ready') },
    awaiting_response: { color: tokens.colors.toolCall.runningText, label: t('generating.awaitingResponse') },
    reasoning: { color: tokens.colors.accent.purple, label: t('generating.thinking') },
    generating: { color: tokens.colors.accent.primary, label: t('generating.generating') },
    applying: { color: tokens.colors.accent.green, label: t('generating.applying') },
    compressing: { color: tokens.colors.accent.orange, label: t('generating.compacting') },
    error: { color: tokens.colors.accent.red, label: t('generating.error') },
  }
  const config = statusConfig[status] || statusConfig.idle
  const [elapsed, setElapsed] = useState(0)

  // Direction arrow next to the token total: ArrowUp while sending (agent is
  // serialising the prompt), ArrowDown while receiving (model is streaming
  // back), nothing when the loop is idle / errored. The number itself is
  // always input + output combined so the user reads "total traffic" — the
  // arrow tells them where on the wire we are RIGHT NOW. Icons (react-icons)
  // instead of the previous string glyphs so the visual is crisp on hi-DPI
  // displays where unicode arrows render with the body font's slightly
  // off-grid baseline.
  const totalTokens = inputTokens + outputTokens
  const isSending = status === 'awaiting_response' || status === 'compressing'
  const isReceiving = status === 'generating' || status === 'reasoning' || status === 'applying'
  const directionIcon: ReactNode = isSending ? (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      color={tokens.colors.accent.orange}
      mr="3px"
      verticalAlign="-2px"
    >
      <FiArrowUp size={11} strokeWidth={2.5} />
    </Box>
  ) : isReceiving ? (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      color={tokens.colors.accent.green}
      mr="3px"
      verticalAlign="-2px"
    >
      <FiArrowDown size={11} strokeWidth={2.5} />
    </Box>
  ) : null

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
        {/* Up + Down combined into a single "total traffic" counter (UX
            request 2026-05-12). Up was context-size-on-wire (max across
            turns); Down was output (sum across turns). The two semantics
            diverge but the user wants the at-a-glance total \u2014 the directional
            split stays available in the session export snapshot. */}
        {totalTokens > 0 && (
          <>
            {directionIcon}{formatTokens(totalTokens)}{' '}
          </>
        )}
        · {currentTurnCount} steps{elapsed > 0 ? ` · ${formatElapsed(elapsed)}` : ''}
      </Text>
    </Flex>
  )
}

export default memo(GeneratingStatusBar)
