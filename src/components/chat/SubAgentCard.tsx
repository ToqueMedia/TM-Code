/**
 * SubAgentCard — collapsed-by-default card showing sub-agent team activity.
 *
 * Renders inside MessageBubble and TerminalMessageRenderer
 * when the message has subAgentRunIds. Each run is an individual sub-agent card
 * inside a collapsible container.
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronRight, FiChevronDown, FiCheck, FiX, FiClock, FiLoader } from 'react-icons/fi'
import { useShallow } from 'zustand/react/shallow'
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

const spinCss = {
  animation: 'agentCardSpin 1s linear infinite',
  '@keyframes agentCardSpin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } },
}
const pulseCss = {
  animation: 'agentCardPulse 1.5s ease-in-out infinite',
  '@keyframes agentCardPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.3 } },
}

function StatusIcon({ status }: { status: SubAgentRun['status'] }) {
  if (status === 'running') {
    return (
      <Box as={FiLoader} boxSize="12px" color={tokens.colors.accent.primary} css={spinCss} />
    )
  }
  if (status === 'completed') return <Box as={FiCheck} boxSize="12px" color={tokens.colors.accent.greenBright} />
  if (status === 'error') return <Box as={FiX} boxSize="12px" color="#f85149" />
  // Timeout ≠ erro: houve trabalho e há resultado PARCIAL — laranja, não vermelho.
  if (status === 'timeout') return <Box as={FiClock} boxSize="12px" color={tokens.colors.accent.orange} />
  return <Box as={FiClock} boxSize="12px" color={tokens.colors.text.disabled} />
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

const SubAgentRunCard = memo(function SubAgentRunCard({ runId }: { runId: string }) {
  const [expanded, setExpanded] = useState(false)

  // Each card subscribes to its own run — only re-renders when THIS run changes.
  const run = useSubAgentStore(state => state.runs.get(runId))

  // Auto-expand when running, collapse when done
  useEffect(() => {
    if (run?.status === 'running') setExpanded(true)
  }, [run?.status])

  if (!run) return null

  const color = AGENT_COLORS[run.definition.agentType] || tokens.colors.text.secondary
  const duration = formatDuration((run.endedAt ?? Date.now()) - run.startedAt)
  // ÚLTIMOS 8 — o card é um feed vivo: com slice(0,8) o user via os 8 calls
  // mais ANTIGOS congelados e a atividade corrente ficava escondida no "+N".
  const maxVisible = 8
  const visibleCalls = run.toolCalls.slice(-maxVisible)
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
        {/* tabular-nums: sem isto a largura do texto oscilava a cada update
            (duração/contagem) e o chevron ml=auto dançava — parte do
            "tremelique" da task #14. */}
        <Text fontSize="10px" color={tokens.colors.text.disabled} css={{ fontVariantNumeric: 'tabular-nums' }}>
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
          {hiddenCount > 0 && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} py="1px">
              +{hiddenCount} earlier
            </Text>
          )}
          {visibleCalls.map(tc => (
            <ToolCallLine key={tc.callId} tc={tc} />
          ))}

          {/* Timeout: houve trabalho — mostra o resultado PARCIAL (finalText,
              escrito por timeoutRun), não só um erro. errorText fica para
              erros reais; antes o timeout renderizava errorText (undefined)
              e o user não via nada do que o sub-agente tinha conseguido. */}
          {run.status === 'timeout' && run.finalText && (
            <Text
              fontSize="11px"
              color={tokens.colors.text.secondary}
              mt="4px"
              p="6px"
              bg="rgba(247, 127, 0, 0.06)"
              borderRadius="4px"
              whiteSpace="pre-wrap"
              maxHeight="120px"
              overflow="hidden"
            >
              {run.finalText.slice(0, 500)}
              {run.finalText.length > 500 && '...'}
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
                css={pulseCss}
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
})

function SubAgentCard({ runIds }: SubAgentCardProps) {
  const [containerExpanded, setContainerExpanded] = useState(false)

  // Subscrição LIMITADA aos runs deste card (task #14): a subscrição antiga
  // era ao Map inteiro — cada tool-event de QUALQUER sub-agent re-renderizava
  // todos os SubAgentCards da história da conversa. Com useShallow sobre a
  // projecção, este card só re-renderiza quando um dos SEUS runs muda.
  const runs = useSubAgentStore(
    useShallow(state => {
      const result: SubAgentRun[] = []
      for (const id of runIds) {
        const run = state.runs.get(id)
        if (run) result.push(run)
      }
      return result
    }),
  )

  const runningCount = useMemo(() => runs.filter(r => r.status === 'running').length, [runs])
  const completedCount = useMemo(() => runs.filter(r => r.status !== 'running').length, [runs])

  // If all runIds are stale (store cleared, session resumed), show faded indicator
  if (runs.length === 0) {
    return (
      <Flex align="center" gap="6px" my="4px" px="12px" py="6px" opacity={0.4}>
        <FiCheck size={12} color={tokens.colors.text.disabled} />
        <Text fontSize="11px" color={tokens.colors.text.disabled}>
          {runIds.length} team task{runIds.length > 1 ? 's' : ''} completed (results expired)
        </Text>
      </Flex>
    )
  }

  const anyRunning = runningCount > 0

  return (
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
                css={pulseCss}
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
              <SubAgentRunCard key={run.id} runId={run.id} />
            ))}
          </Box>
        )}
      </Box>
  )
}

export default memo(SubAgentCard)
