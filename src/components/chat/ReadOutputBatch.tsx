import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiLoader, FiX, FiChevronRight, FiChevronDown, FiAlertTriangle } from 'react-icons/fi'
import { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'

/**
 * Consolidated row for a streak of consecutive `read_large_result` tool
 * calls that all target the SAME large_result id. Previously each paginated
 * read rendered as its own ToolCallDisplay row, producing stacks like:
 *
 *   [Reading output large_result_4 — offset 28000, limit 2000]
 *   [Reading output large_result_4 — offset 27500, limit 1500]
 *   [Reading output large_result_4 — offset 22000, limit 2000]
 *
 * after a single agent investigation. This batch collapses them into one
 * row showing the union of ranges read, sorted ascending so overlap is
 * visually obvious. Limited to the `read_large_result` tool — any other
 * tool falls back to the standard one-row-per-call rendering.
 */

interface ReadOutputBatchProps {
  /** All calls in the batch — guaranteed by the grouper to share the same
   *  `input.id` and to be consecutive in the parent message's toolCalls. */
  calls: ToolCallDisplayType[]
}

interface ParsedRead {
  offset: number
  limit: number
  end: number
  status: ToolCallDisplayType['status']
}

function parseRead(tc: ToolCallDisplayType): ParsedRead {
  const offset = Math.max(0, Number(tc.input?.offset) || 0)
  const limit = Math.max(0, Number(tc.input?.limit) || 10000)
  return { offset, limit, end: offset + limit, status: tc.status }
}

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}

/**
 * Walk pre-sorted ranges and return true iff any pair overlaps. Used to
 * surface re-reads — useful diagnostic for "agent is going in circles".
 */
function hasOverlap(ranges: ParsedRead[]): boolean {
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].offset < ranges[i - 1].end) return true
  }
  return false
}

function ReadOutputBatchComponent({ calls }: ReadOutputBatchProps) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const id = String(calls[0]?.input?.id ?? 'unknown')
  const reads = calls.map(parseRead)
  const sorted = [...reads].sort((a, b) => a.offset - b.offset)
  const overlap = hasOverlap(sorted)

  const last = calls[calls.length - 1]
  const isRunning = last.status === 'running'
  const isFailed = calls.some(c => c.status === 'failed')

  // Compact range pills — sorted by offset so overlap is visually obvious.
  // Cap at 4 pills + "+N more" so the header stays one line even on big batches.
  const MAX_PILLS = 4
  const visiblePills = sorted.slice(0, MAX_PILLS)
  const extraCount = sorted.length - visiblePills.length

  return (
    <Box
      my={1.5}
      borderRadius="6px"
      border={`1px solid ${isFailed ? 'rgba(248, 81, 73, 0.12)' : isRunning ? 'rgba(240, 192, 0, 0.12)' : 'rgba(255, 255, 255, 0.04)'}`}
      bg={isFailed ? 'rgba(248, 81, 73, 0.03)' : isRunning ? 'rgba(240, 192, 0, 0.03)' : 'rgba(255, 255, 255, 0.015)'}
      transition="all 0.15s"
    >
      <Flex
        align="center"
        gap={2}
        px={3}
        py="8px"
        cursor="pointer"
        _hover={{ bg: 'rgba(255, 255, 255, 0.02)' }}
        transition="background 0.1s"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Status indicator — pinned to the LAST read's status; failed wins. */}
        {isFailed ? (
          <Box color={tokens.colors.accent.red} flexShrink={0}>
            <FiX size={12} />
          </Box>
        ) : isRunning ? (
          <Box
            color={tokens.colors.toolCall.runningText}
            flexShrink={0}
            css={{
              animation: 'toolSpin 1s linear infinite',
              '@keyframes toolSpin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
            }}
          >
            <FiLoader size={12} />
          </Box>
        ) : (
          <Box color={tokens.colors.accent.green} flexShrink={0}>
            <FiCheck size={12} />
          </Box>
        )}

        <Text
          color={tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          flexShrink={0}
          fontWeight="500"
        >
          Reading output
        </Text>
        <Text
          color={tokens.colors.text.disabled}
          fontSize="11px"
          fontFamily={tokens.fontFamily.mono}
          flexShrink={0}
        >
          {id} · {calls.length} read{calls.length === 1 ? '' : 's'}
        </Text>

        {/* Range pills — sorted ascending so overlap reads left-to-right. */}
        <Flex gap={1} flex="1" overflow="hidden" align="center">
          {visiblePills.map((r, i) => (
            <Box
              key={i}
              px="6px"
              py="1px"
              borderRadius="3px"
              bg="rgba(255, 255, 255, 0.04)"
              fontSize="10px"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.text.muted}
              flexShrink={0}
            >
              {formatChars(r.offset)}–{formatChars(r.end)}
            </Box>
          ))}
          {extraCount > 0 && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
              {t('readOutput.more').replace('{count}', String(extraCount))}
            </Text>
          )}
          {overlap && (
            <Box color={tokens.colors.accent.orange} flexShrink={0} title={t('readOutput.overlapping')}>
              <FiAlertTriangle size={11} />
            </Box>
          )}
        </Flex>

        <Box color={tokens.colors.text.disabled} flexShrink={0}>
          {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
        </Box>
      </Flex>

      {/* Expanded: full per-read list in chronological (call) order, NOT sorted —
          so the developer can see the actual sequence the agent took. */}
      {expanded && (
        <Box px={3} py="6px" borderTop="1px solid rgba(255,255,255,0.04)">
          {reads.map((r, i) => (
            <Flex key={i} gap={2} fontSize="11px" fontFamily={tokens.fontFamily.mono} py="2px" align="center">
              <Text color={tokens.colors.text.disabled} w="20px" textAlign="right">#{i + 1}</Text>
              <Text color={tokens.colors.text.secondary}>
                offset {r.offset.toLocaleString()} · limit {r.limit.toLocaleString()}
              </Text>
              <Text color={tokens.colors.text.disabled}>→ {formatChars(r.offset)}–{formatChars(r.end)}</Text>
              {r.status === 'running' && <Text color={tokens.colors.toolCall.runningText}>running…</Text>}
              {r.status === 'failed' && <Text color={tokens.colors.accent.red}>failed</Text>}
            </Flex>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default memo(ReadOutputBatchComponent)
