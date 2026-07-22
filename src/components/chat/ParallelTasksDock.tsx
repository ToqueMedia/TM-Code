/**
 * ParallelTasksDock — compact panel below the composer showing the user's
 * parallel task agents (v1.0.1 multi-agent): up to 4 running concurrently, the
 * rest queued. Each row is a live card (status + latest tool call + tokens) with
 * a per-task Stop; the header carries Stop-all + Clear. Renders nothing when
 * there are no tasks. Reads parallelTaskStore only — never the chat transcript.
 */

import { memo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { VscClose, VscLoading } from 'react-icons/vsc'
import { tokens } from '@/theme/tokens'
import {
  useParallelTaskStore,
  type ParallelTaskRun,
  type ParallelTaskStatus,
} from '@/stores/parallelTaskStore'

const pulseCss = {
  animation: 'ptSpin 1s linear infinite',
  '@keyframes ptSpin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
}

function statusColor(status: ParallelTaskStatus): string {
  switch (status) {
    case 'running': return tokens.colors.accent.primary
    case 'completed': return tokens.colors.accent.greenBright
    case 'error': return tokens.colors.accent.red
    default: return tokens.colors.text.muted // queued | aborted
  }
}

function statusLabel(status: ParallelTaskStatus): string {
  switch (status) {
    case 'running': return 'Running'
    case 'queued': return 'Queued'
    case 'completed': return 'Done'
    case 'error': return 'Error'
    case 'aborted': return 'Stopped'
  }
}

function TaskRow({ run }: { run: ParallelTaskRun }) {
  const abort = useParallelTaskStore((s) => s.abort)
  const color = statusColor(run.status)
  const lastCall = run.toolCalls[run.toolCalls.length - 1]
  const active = run.status === 'running' || run.status === 'queued'
  const subtitle =
    run.status === 'error'
      ? run.errorText ?? 'failed'
      : run.status === 'completed'
        ? run.finalText.split('\n')[0].slice(0, 80) || 'completed'
        : lastCall
          ? `${lastCall.toolName}${lastCall.argPreview ? ` ${lastCall.argPreview}` : ''}`
          : run.status === 'queued'
            ? 'waiting for a free slot'
            : 'starting…'

  return (
    <Flex align="center" gap={2} px={2} py={1.5} borderRadius="5px" _hover={{ bg: 'rgba(255,255,255,0.03)' }}>
      {run.status === 'running' ? (
        <Box as="span" css={pulseCss} color={color} flexShrink={0} display="flex">
          <VscLoading size={12} />
        </Box>
      ) : (
        <Box w="7px" h="7px" borderRadius="full" bg={color} flexShrink={0} />
      )}
      <Box minW={0} flex={1}>
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1}>
          {run.description}
        </Text>
        <Text fontSize="10px" color={tokens.colors.text.muted} lineClamp={1} fontFamily={tokens.fontFamily.mono}>
          {subtitle}
        </Text>
      </Box>
      <Text fontSize="9px" color={color} flexShrink={0} textTransform="uppercase" letterSpacing="0.04em">
        {statusLabel(run.status)}
      </Text>
      {run.tokenUsage.output > 0 && (
        <Text fontSize="9px" color={tokens.colors.text.disabled} flexShrink={0} fontFamily={tokens.fontFamily.mono}>
          {run.tokenUsage.output.toLocaleString()}t
        </Text>
      )}
      {active && (
        <Box
          as="button"
          aria-label="Stop task"
          title="Stop task"
          color={tokens.colors.text.muted}
          _hover={{ color: tokens.colors.accent.red }}
          flexShrink={0}
          onClick={() => abort(run.id)}
        >
          <VscClose size={13} />
        </Box>
      )}
    </Flex>
  )
}

function ParallelTasksDock() {
  const runs = useParallelTaskStore((s) => s.runs)
  const abortAll = useParallelTaskStore((s) => s.abortAll)
  const clearFinished = useParallelTaskStore((s) => s.clearFinished)

  const list = Array.from(runs.values()).sort((a, b) => a.createdAt - b.createdAt)
  if (list.length === 0) return null

  const running = list.filter((r) => r.status === 'running').length
  const queued = list.filter((r) => r.status === 'queued').length
  const anyActive = running + queued > 0
  const anyFinished = list.some((r) => r.status !== 'running' && r.status !== 'queued')

  return (
    <Box
      mt={1.5}
      borderRadius="6px"
      bg="rgba(255,255,255,0.02)"
      border="1px solid"
      borderColor="rgba(255,255,255,0.06)"
      overflow="hidden"
    >
      <Flex align="center" gap={2} px={2.5} py={1.5} borderBottom="1px solid" borderColor="rgba(255,255,255,0.05)">
        <Text fontSize="10px" fontWeight="700" letterSpacing="0.06em" textTransform="uppercase" color={tokens.colors.text.muted}>
          Parallel tasks
        </Text>
        <Text fontSize="10px" color={tokens.colors.text.disabled}>
          {running} running{queued > 0 ? ` · ${queued} queued` : ''}
        </Text>
        <Box flex={1} />
        {anyFinished && (
          <Box as="button" fontSize="10px" color={tokens.colors.text.muted} _hover={{ color: tokens.colors.text.primary }} onClick={() => clearFinished()}>
            Clear
          </Box>
        )}
        {anyActive && (
          <Box as="button" fontSize="10px" fontWeight="600" color={tokens.colors.accent.red} _hover={{ opacity: 0.8 }} onClick={() => abortAll()}>
            Stop all
          </Box>
        )}
      </Flex>
      <Box px={1} py={1}>
        {list.map((run) => (
          <TaskRow key={run.id} run={run} />
        ))}
      </Box>
    </Box>
  )
}

export default memo(ParallelTasksDock)
