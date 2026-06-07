import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface CommandLogViewerProps {
  /** Accumulated log lines from the streaming command. */
  logs: string[]
  /** Whether the command is still running. */
  isRunning: boolean
  /** Maximum number of lines to show in the compact (collapsed) view. */
  compactLines?: number
}

/**
 * Terminal-style log viewer for streaming command output (build, test, install,
 * lint, scripts). Renders in a monospace scrollable container with auto-scroll
 * and an expand/collapse toggle for long outputs.
 *
 * Used by both CMD mode (TerminalToolCall) and Chat mode (ToolCallDisplay).
 */
export const CommandLogViewer = memo(function CommandLogViewer({
  logs,
  isRunning,
  compactLines = 8,
}: CommandLogViewerProps) {
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)

  // Auto-scroll to bottom when new logs arrive (if user was already at bottom).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs.length])

  // Track scroll position to detect user scroll-away.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    wasAtBottomRef.current = atBottom
  }, [])

  if (logs.length === 0 && !isRunning) return null

  const totalLines = logs.length
  const showToggle = totalLines > compactLines
  const visibleLogs = expanded || !showToggle ? logs : logs.slice(-compactLines)

  return (
    <Box
      mt="3px"
      borderRadius="4px"
      overflow="hidden"
      border={`1px solid ${isRunning ? 'rgba(240, 192, 0, 0.1)' : 'rgba(255, 255, 255, 0.04)'}`}
      bg="rgba(0, 0, 0, 0.25)"
    >
      {/* Header bar with toggle */}
      {showToggle && (
        <Flex
          align="center"
          justify="space-between"
          px={2}
          py="3px"
          borderBottom={`1px solid rgba(255, 255, 255, 0.04)`}
          cursor="pointer"
          _hover={{ bg: 'rgba(255, 255, 255, 0.02)' }}
          onClick={() => setExpanded(!expanded)}
        >
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
          >
            {expanded ? `▲ ${totalLines} lines` : `▼ ${totalLines} lines (showing last ${compactLines})`}
          </Text>
          {isRunning && (
            <Flex align="center" gap={1}>
              <Box
                w="5px"
                h="5px"
                borderRadius="full"
                bg={tokens.colors.toolCall.runningText}
                css={{
                  animation: 'logPulse 1.4s ease-in-out infinite',
                  '@keyframes logPulse': {
                    '0%, 100%': { opacity: 0.35 },
                    '50%': { opacity: 1 },
                  },
                }}
              />
              <Text fontSize="10px" color={tokens.colors.toolCall.runningText} fontFamily={tokens.fontFamily.mono}>
                streaming
              </Text>
            </Flex>
          )}
        </Flex>
      )}

      {/* Log content */}
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        maxH={expanded || !showToggle ? '320px' : `${compactLines * 18 + 8}px`}
        overflowY="auto"
        overflowX="hidden"
        px={2}
        py="4px"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
        }}
      >
        {visibleLogs.map((line, i) => (
          <Text
            key={i}
            fontSize="11px"
            fontFamily={tokens.fontFamily.mono}
            color={getLineColor(line)}
            whiteSpace="pre-wrap"
            wordBreak="break-all"
            lineHeight="18px"
            minH="18px"
          >
            {line}
          </Text>
        ))}

        {/* Running indicator at the bottom */}
        {isRunning && (
          <Flex align="center" gap={1} mt="2px">
            <Box
              w="4px"
              h="4px"
              borderRadius="full"
              bg={tokens.colors.toolCall.runningText}
              css={{
                animation: 'logDotBlink 1s steps(2, start) infinite',
                '@keyframes logDotBlink': {
                  '0%': { opacity: 1 },
                  '50%': { opacity: 0 },
                },
              }}
            />
          </Flex>
        )}
      </Box>
    </Box>
  )
})

/**
 * Color log lines based on common patterns:
 * - Errors/warnings: red/orange
 * - Success indicators: green
 * - Default: muted foreground
 */
function getLineColor(line: string): string {
  const lower = line.toLowerCase()
  // Error patterns
  if (/^(?:error|fatal|fail(?:ed)?|✗|✘|\[error\])/i.test(line)) return tokens.colors.accent.red
  if (/error|exception|panic|fatal/i.test(lower) && !/0 error/i.test(line)) return tokens.colors.accent.red
  // Warning patterns
  if (/^(?:warn(?:ing)?|⚠|\[warn\])/i.test(line)) return tokens.colors.accent.orange
  // Success patterns
  if (/^(?:success|✓|✔|done|ok(?:ay)?|\[ok\])/i.test(line)) return tokens.colors.accent.green
  if (/\bpassed\b|\bsuccess\b/i.test(lower)) return tokens.colors.accent.green
  // Progress indicators (npm/pnpm style)
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-]+$/.test(line.trim())) return tokens.colors.text.disabled
  // Default
  return tokens.colors.text.muted
}
