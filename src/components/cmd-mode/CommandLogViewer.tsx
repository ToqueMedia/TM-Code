import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { Spinner } from './terminalSpinner'

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
    // Flat: log output flows flush, bound only by a left gutter in the state
    // color (yellow while running, hairline otherwise). No card border/radius/fill,
    // no header chrome bar (refined-terminal).
    <Box
      mt="3px"
      pl={2}
      borderLeft={`2px solid ${isRunning ? tokens.colors.toolCall.runningText : tokens.colors.border.default}`}
    >
      {/* Toggle row — flush, no chrome bar */}
      {showToggle && (
        <Flex
          align="center"
          justify="space-between"
          py="3px"
          cursor="pointer"
          _hover={{ opacity: 0.8 }}
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
            <Flex align="center" gap={1} color={tokens.colors.toolCall.runningText}>
              {/* Hard-step spinner replaces the eased `logPulse` dot. */}
              <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} lineHeight="1">
                <Spinner active />
              </Text>
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
        pr={2}
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
