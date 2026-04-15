import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { diffLines } from 'diff'
import type { ToolCallDisplay } from '../../types/chat'
import { tokens } from '@/theme/tokens'

interface TerminalToolCallProps {
  toolCall: ToolCallDisplay
}

// Truncate long tool arg strings for compact display
function truncateArg(val: unknown, max = 60): string {
  const s = typeof val === 'string' ? val : JSON.stringify(val)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export const TerminalToolCall = memo(function TerminalToolCall({ toolCall }: TerminalToolCallProps) {
  const isError = toolCall.isError || toolCall.status === 'failed'
  const isRunning = toolCall.status === 'running'
  const hasDiff = toolCall.diffOldContent !== undefined || toolCall.diffNewContent !== undefined

  const diffResult = useMemo(() => {
    if (!hasDiff) return null
    return diffLines(toolCall.diffOldContent || '', toolCall.diffNewContent || '')
  }, [hasDiff, toolCall.diffOldContent, toolCall.diffNewContent])

  const diffHunks = useMemo(() => {
    if (!diffResult) return null
    const filtered = diffResult.filter(p => p.added || p.removed)
    return { lines: filtered.slice(0, 80), totalCount: filtered.length }
  }, [diffResult])

  // Determine primary display: file path or tool name
  const filePath = toolCall.input?.file_path ? String(toolCall.input.file_path) : null
  const fileName = filePath ? filePath.split('/').pop() : null

  // Status symbol
  const statusSymbol = isRunning ? '⟳' : isError ? '✗' : '✓'
  const statusColor = isRunning
    ? tokens.colors.toolCall.runningText
    : isError
    ? tokens.colors.accent.red
    : tokens.colors.accent.green

  // Build a compact args string when no diff and no file path
  const argsStr = useMemo(() => {
    if (!toolCall.input || hasDiff || filePath) return null
    const entries = Object.entries(toolCall.input).slice(0, 3)
    return entries.map(([k, v]) => `${k}=${truncateArg(v)}`).join('  ')
  }, [toolCall.input, hasDiff, filePath])

  return (
    <Box my={1} fontFamily={tokens.fontFamily.mono}>
      {/* Header line: ✓ tool_name  file/args  [NEW] */}
      <Flex align="center" gap={1.5} wrap="wrap">
        <Text fontSize="12px" fontWeight="700" color={statusColor} flexShrink={0}
          css={isRunning ? {
            display: 'inline-block',
            animation: 'toolSpin 1.2s linear infinite',
            '@keyframes toolSpin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } }
          } : undefined}
        >
          {statusSymbol}
        </Text>

        <Text fontSize="12px" fontWeight="600" color={tokens.colors.terminal.foreground} flexShrink={0}>
          {toolCall.toolName}
        </Text>

        {filePath && (
          <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            {filePath}
          </Text>
        )}

        {toolCall.isNewFile && (
          <Text
            fontSize="9px"
            color={tokens.colors.accent.green}
            border="1px solid"
            borderColor="rgba(46,160,67,0.35)"
            px="4px"
            py="0px"
            borderRadius="2px"
            fontWeight="700"
            letterSpacing="0.06em"
          >
            NEW
          </Text>
        )}

        {argsStr && !hasDiff && (
          <Text fontSize="11px" color={tokens.colors.text.disabled}>
            {argsStr}
          </Text>
        )}
      </Flex>

      {/* Body: indented under the header line */}
      <Box pl={4} mt="2px" borderLeft={`1px solid ${isError ? 'rgba(248,81,73,0.2)' : 'rgba(255,255,255,0.06)'}`}>
        {/* Diff hunk */}
        {diffHunks && (
          <Box my={1} borderRadius="2px" overflow="hidden" border="1px solid rgba(255,255,255,0.05)">
            <Box px={2} py="3px" borderBottom="1px solid rgba(255,255,255,0.04)" bg="rgba(255,255,255,0.02)">
              <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                {toolCall.isNewFile ? '--- /dev/null' : `--- ${fileName}`}
                {'  '}
                {`+++ ${fileName}`}
              </Text>
            </Box>
            <Box fontSize="11px" fontFamily={tokens.fontFamily.mono} lineHeight="1.35">
              {diffHunks.lines.map((part, i) => (
                <Text
                  key={i}
                  px={2}
                  color={part.added ? tokens.colors.diff.addedText : tokens.colors.diff.removedText}
                  bg={part.added ? tokens.colors.diff.addedBg : tokens.colors.diff.removedBg}
                  whiteSpace="pre-wrap"
                  wordBreak="break-all"
                >
                  {part.added ? '+' : '-'}{part.value.trimEnd()}
                </Text>
              ))}
              {diffHunks.totalCount > 80 && (
                <Text px={2} color={tokens.colors.text.disabled} fontSize="10px">
                  … {diffHunks.totalCount - 80} more hunks
                </Text>
              )}
            </Box>
          </Box>
        )}

        {/* Tool result */}
        {toolCall.result && !hasDiff && (
          <Text
            fontSize="11px"
            color={isError ? tokens.colors.accent.red : tokens.colors.text.secondary}
            whiteSpace="pre-wrap"
            mt="2px"
            lineHeight="1.45"
          >
            {toolCall.result.slice(0, 1200)}
            {toolCall.result.length > 1200 ? '\n… (truncated)' : ''}
          </Text>
        )}

        {/* Progress text */}
        {toolCall.progressText && (
          <Text fontSize="11px" color={tokens.colors.toolCall.runningText} mt="2px">
            ⟳ {toolCall.progressText}
          </Text>
        )}
      </Box>
    </Box>
  )
})
