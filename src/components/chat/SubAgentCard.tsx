/**
 * SubAgentCard — collapsed-by-default card showing sub-agent team activity.
 *
 * Renders inside MessageBubble (chat-mode) and TerminalMessageRenderer (cmd-mode)
 * when the message has subAgentRunIds. Each run is an individual sub-agent card
 * inside a collapsible container.
 */

import { memo, useMemo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronRight, FiChevronDown, FiCheck, FiX, FiClock, FiLoader } from 'react-icons/fi'
import { useSubAgentStore } from '../../stores/subAgentStore'
import { AGENT_COLORS } from '../../services/agent/subAgents/colors'
import type { SubAgentRun, SubAgentToolCallSummary } from '../../services/agent/subAgents/types'
import { tokens } from '@/theme/tokens'

interface SubAgentCardProps {
  runIds: string[]
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}m ${rem}s`
}

const spinKeyframes = `@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`
const pulseKeyframes = `@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`

function StatusIcon({ status }: { status: SubAgentRun['status'] }) {
  if (status === 'running') {
    return (
      <FiLoader
        size={12}
        color={tokens.colors.accent.primary}
        style={{ animation: 'spin 1s linear infinite' }}
      />
    )
  }
  if (status === 'completed') return <FiCheck size={12} color={tokens.colors.accent.greenBright} />
  if (status === 'error' || status === 'timeout') return <FiX size={12} color="#f85149" />
  return <FiClock size={12} color={tokens.colors.text.disabled} />
}

function ToolCallLine({ tc }: { tc: SubAgentToolCallSummary }) {
  const statusSymbol = tc.status === 'completed' ? '\u2713'
    : tc.status === 'errored' ? '\u2717'
    : tc.status === 'running' ? '\u27F3'
    : '\u25CB'

  return (
    <Flex align="center" gap="6px" py="1px" fontSize="11px" fontFamily={tokens.fontFamily.mono}>
      <Text color={tc.status === 'errored' ? '#f85149' : tokens.colors.text.disabled} flexShrink={0}>
        {statusSymbol}
      </Text>
      <Text color={tokens.colors.text.secondary} truncate maxW="200px">
        {tc.toolName}
      </Text>
      {tc.argPreview && (
        <Text color={tokens.colors.text.disabled} truncate maxW="240px">
          {tc.argPreview}
        </Text>
      )}
    </Flex>
  )
}

function SubAgentRunCard({ run }: { run: SubAgentRun }) {
  const [expanded, setExpanded] = useState(run.status === 'running')
  const color = AGENT_COLORS[run.definition.agentType] || tokens.colors.text.secondary
  const duration = formatDuration((run.endedAt ?? Date.now()) - run.startedAt)

  const maxVisible = 8
  const visibleCalls = run.toolCalls.slice(0, maxVisible)
  const hiddenCount = run.toolCalls.length - maxVisible

  return (
    <Box
      borderLeft="2px solid"
      borderColor={color}
      pl="10px"
      py="6px"
      mb="4px"
      borderRadius="0 4px 4px 0"
      bg="rgba(255,255,255,0.02)"
    >
      {/* Header — always visible */}
      <Flex
        align="center"
        gap="6px"
        cursor="pointer"
        onClick={() => setExpanded(!expanded)}
        userSelect="none"
      >
        <StatusIcon status={run.status} />
        <Text fontSize="12px" fontWeight="600" color={color}>
          {run.definition.agentType}
        </Text>
        <Text fontSize="11px" color={tokens.colors.text.secondary} truncate maxW="180px">
          {run.description}
        </Text>
        <Text fontSize="10px" color={tokens.colors.text.disabled}>
          {run.status === 'running' ? 'running' : run.status} · {duration}
          {run.toolCalls.length > 0 && ` · ${run.toolCalls.length} calls`}
        </Text>
        <Box ml="auto" color={tokens.colors.text.disabled}>
          {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        </Box>
      </Flex>

      {/* Expanded: tool calls + result */}
      {expanded && (
        <Box mt="4px" pl="4px">
          {visibleCalls.map(tc => (
            <ToolCallLine key={tc.callId} tc={tc} />
          ))}
          {hiddenCount > 0 && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} py="1px">
              +{hiddenCount} more
            </Text>
          )}

          {/* Final text / error */}
          {run.status === 'completed' && run.finalText && (
            <Text
              fontSize="11px"
              color={tokens.colors.text.secondary}
              mt="4px"
              p="6px"
              bg="rgba(255,255,255,0.03)"
              borderRadius="4px"
              whiteSpace="pre-wrap"
              maxHeight="120px"
              overflow="hidden"
            >
              {run.finalText.slice(0, 500)}
              {run.finalText.length > 500 && '...'}
            </Text>
          )}
          {(run.status === 'error' || run.status === 'timeout') && run.errorText && (
            <Text fontSize="11px" color="#f85149" mt="4px">
              {run.errorText.slice(0, 200)}
            </Text>
          )}
          {run.status === 'running' && (
            <Flex align="center" gap="6px" mt="4px">
              <Box
                w="4px"
                h="4px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                style={{ animation: 'pulse 1.5s ease-in-out infinite' }}
              />
              <Text fontSize="10px" color={tokens.colors.text.disabled}>
                Working...
              </Text>
            </Flex>
          )}
        </Box>
      )}
    </Box>
  )
}

function SubAgentCard({ runIds }: SubAgentCardProps) {
  const [containerExpanded, setContainerExpanded] = useState(false)

  const runs = useSubAgentStore(state => {
    const result: SubAgentRun[] = []
    for (const id of runIds) {
      const run = state.runs.get(id)
      if (run) result.push(run)
    }
    return result
  })

  const runningCount = useMemo(() => runs.filter(r => r.status === 'running').length, [runs])
  const completedCount = useMemo(() => runs.filter(r => r.status !== 'running').length, [runs])

  if (runs.length === 0) return null

  const anyRunning = runningCount > 0

  return (
    <>
      {/* Inject keyframes once */}
      <style>{spinKeyframes}{pulseKeyframes}</style>
      <Box
        my="6px"
        borderRadius="8px"
        border="1px solid"
        borderColor="rgba(255,255,255,0.06)"
        bg="rgba(255,255,255,0.015)"
        overflow="hidden"
      >
        {/* Container header — always visible */}
        <Flex
          align="center"
          gap="8px"
          px="12px"
          py="8px"
          cursor="pointer"
          onClick={() => setContainerExpanded(!containerExpanded)}
          userSelect="none"
          _hover={{ bg: 'rgba(255,255,255,0.02)' }}
          transition="background 0.15s"
        >
          <Box color={tokens.colors.text.disabled}>
            {containerExpanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
          </Box>
          <Text fontSize="12px" fontWeight="500" color={tokens.colors.text.secondary}>
            Team Activity
          </Text>
          {anyRunning && (
            <Flex align="center" gap="4px">
              <Box
                w="5px"
                h="5px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                style={{ animation: 'pulse 1.5s ease-in-out infinite' }}
              />
              <Text fontSize="11px" color={tokens.colors.accent.primary}>
                {runningCount} running
              </Text>
            </Flex>
          )}
          {completedCount > 0 && (
            <Text fontSize="11px" color={tokens.colors.text.disabled}>
              {completedCount} done
            </Text>
          )}
        </Flex>

        {/* Expanded: individual sub-agent cards */}
        {(containerExpanded || anyRunning) && (
          <Box px="12px" pb="8px">
            {runs.map(run => (
              <SubAgentRunCard key={run.id} run={run} />
            ))}
          </Box>
        )}
      </Box>
    </>
  )
}

export default memo(SubAgentCard)
