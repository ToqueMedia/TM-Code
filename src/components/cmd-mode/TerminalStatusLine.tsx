/**
 * TerminalStatusLine — bottom status bar for CMD mode.
 * Shows: agent status dot + label · info segments · elapsed · tokens · stop button
 * Also renders the agent task list above the status bar when tasks are present.
 *
 * Memoized to isolate timer ticks from causing full-view re-renders.
 */
import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAgentElapsed } from '../../hooks/useAgentElapsed'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiLoader, FiSquare } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useAgentStore, type AgentTask } from '../../stores/agentStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSkillStore } from '../../stores/skillStore'
import { stopAgent } from '../../services/agent/cmdModeCommands'
import { getCommandQueueSnapshot, subscribeToCommandQueue } from '../../services/agent/messageQueue'
import { usePreflightStatus } from '../../hooks/usePreflightStatus'
import { countAvailable } from '../../services/preflightService'
import { tokens } from '@/theme/tokens'
import { formatElapsed, formatTokens } from './terminalHelpers'

export const TerminalStatusLine = memo(function TerminalStatusLine() {
  const status = useAgentStore(s => s.status)
  const error = useAgentStore(s => s.error)
  const isStreaming = useChatStore(s => s.isStreaming)
  const totalTokensUsed = useChatStore(s => s.totalTokensUsed)
  const agentTasks = useAgentStore(s => s.tasks)
  const skillCount = useSkillStore(s => s.skills.length)
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const totalMcpTools = useMcpStore(s => s.getTotalToolCount())
  const autoApproveDiffs = usePermissionStore(s => s.autoApproveDiffs)
  const queuedCommands = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
  const queueLength = queuedCommands.length
  const preflight = usePreflightStatus()

  // Session-mode elapsed: total wall time per request, freezes during permission waits.
  const { elapsedMs: elapsed } = useAgentElapsed('session')

  const handleStop = useCallback(async () => {
    await stopAgent()
  }, [])

  const cfg = useMemo(() => {
    switch (status) {
      case 'awaiting_response': return { color: tokens.colors.toolCall.runningText, label: 'awaiting', pulse: true }
      case 'reasoning':         return { color: tokens.colors.accent.purple,        label: 'reasoning', pulse: true }
      case 'generating':        return { color: tokens.colors.accent.primary,       label: 'writing', pulse: true }
      case 'applying':          return { color: tokens.colors.accent.green,         label: 'applying', pulse: true }
      case 'compressing':       return { color: tokens.colors.accent.orange,        label: 'compressing', pulse: true }
      case 'error':             return { color: tokens.colors.accent.red,           label: error || 'error', pulse: false }
      default:                  return { color: tokens.colors.text.disabled,        label: 'ready', pulse: false }
    }
  }, [status, error])

  // Up = context size on the wire (input is replaced with max across turns).
  // Down = output emitted by model (sums across turns). Two distinct quantities;
  // do not add them — see chatStore.addTokenUsage for the why.
  const inputTok = totalTokensUsed.input
  const outputTok = totalTokensUsed.output
  const isSending = status === 'awaiting_response' || status === 'compressing'

  // Toolkit preflight — small "tk 3/3" indicator. Tooltip lists missing pieces.
  const toolkit = useMemo(() => {
    if (!preflight.ranAt) return null
    const { available, total } = countAvailable(preflight)
    const missing: string[] = []
    if (!preflight.pandoc.found) missing.push('pandoc')
    if (!preflight.venv.found) missing.push('python venv')
    if (!preflight.npx.found) missing.push('npx')
    const label = `tk ${available}/${total}`
    const title = missing.length
      ? `Missing: ${missing.join(', ')}. Some artifact skills (PDF/Word/Excel/PPTX/Slidev) will need installs.`
      : 'All artifact-generation tooling available.'
    return { label, title, allGreen: missing.length === 0 }
  }, [preflight])

  // Info segments — compact, terminal style
  const segments = useMemo(() => {
    const out: string[] = []
    if (autoApproveDiffs) out.push('auto-approve')
    if (queueLength > 0) out.push(`${queueLength}q`)
    if (skillCount > 0) out.push(`${skillCount} skills`)
    if (mcpIsInitializing) {
      out.push('mcp…')
    } else {
      const running = mcpServers.filter(s => s.status === 'running').length
      if (running > 0) out.push(`${running} mcp (${totalMcpTools})`)
    }
    return out
  }, [autoApproveDiffs, queueLength, skillCount, mcpIsInitializing, mcpServers, totalMcpTools])

  return (
    <>
      {/* Agent task list — shown above status bar when tasks exist */}
      {agentTasks.length > 0 && (
        <Box
          px={3}
          pt={1.5}
          pb={1}
          borderTop="1px solid rgba(255,255,255,0.04)"
          bg="rgba(0,0,0,0.1)"
        >
          <Text
            fontSize="9px"
            fontWeight="700"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            textTransform="uppercase"
            letterSpacing="0.1em"
            mb="4px"
          >
            {agentTasks.filter((t: AgentTask) => t.status === 'completed').length}/{agentTasks.length} tasks
          </Text>
          {agentTasks.map((task: AgentTask) => (
            <Flex key={task.id} align="center" gap={1.5} py="1px">
              {task.status === 'completed' ? (
                <FiCheck size={9} color={tokens.colors.accent.green} style={{ flexShrink: 0 }} />
              ) : task.status === 'in_progress' ? (
                <Box
                  as={FiLoader}
                  boxSize="9px"
                  color={tokens.colors.accent.purple}
                  flexShrink={0}
                  css={{
                    animation: 'taskSpin 1.5s linear infinite',
                    '@keyframes taskSpin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } },
                  }}
                />
              ) : (
                <Box w="9px" h="9px" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
                  <Box w="3px" h="3px" borderRadius="full" bg={tokens.colors.text.disabled} />
                </Box>
              )}
              <Text
                fontSize="11px"
                color={task.status === 'completed' ? tokens.colors.text.disabled : tokens.colors.text.secondary}
                textDecoration={task.status === 'completed' ? 'line-through' : 'none'}
                fontFamily={tokens.fontFamily.mono}
                lineHeight="1.35"
              >
                {task.description}
              </Text>
            </Flex>
          ))}
        </Box>
      )}

      {/* Status bar */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py="5px"
        borderTop="1px solid rgba(255,255,255,0.04)"
        bg="rgba(0,0,0,0.2)"
        minH="24px"
        flexShrink={0}
      >
        {/* Left: status dot + label + info */}
        <Flex align="center" gap={2} overflow="hidden">
          {/* Status dot */}
          <Box
            w="5px"
            h="5px"
            borderRadius="full"
            bg={cfg.color}
            flexShrink={0}
            css={cfg.pulse ? {
              animation: 'sPulse 1.5s ease-in-out infinite',
              '@keyframes sPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.25 } },
            } : undefined}
          />
          <Text
            fontSize="10px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="600"
          >
            {cfg.label}
          </Text>

          {segments.length > 0 && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              {segments.join(' · ')}
            </Text>
          )}

          {toolkit && (
            <Text
              fontSize="10px"
              color={toolkit.allGreen ? tokens.colors.accent.green : tokens.colors.accent.orange}
              fontFamily={tokens.fontFamily.mono}
              title={toolkit.title}
            >
              {toolkit.label}
            </Text>
          )}
        </Flex>

        {/* Right: elapsed + tokens + stop */}
        <Flex align="center" gap={2} flexShrink={0}>
          {isStreaming && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} whiteSpace="nowrap">
              {formatElapsed(elapsed)}
              {inputTok > 0 && (
                <>
                  {' · '}
                  <Text as="span" color={isSending ? tokens.colors.accent.orange : tokens.colors.text.disabled}>
                    {'↑'}
                  </Text>
                  {' '}{formatTokens(inputTok)}
                </>
              )}
              {outputTok > 0 && (
                <>
                  {' · '}
                  <Text as="span" color={!isSending ? tokens.colors.accent.green : tokens.colors.text.disabled}>
                    {'↓'}
                  </Text>
                  {' '}{formatTokens(outputTok)}
                </>
              )}
            </Text>
          )}

          {/* Stop button */}
          {isStreaming && (
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="18px"
              h="18px"
              borderRadius="3px"
              bg="transparent"
              color={tokens.colors.accent.red}
              cursor="pointer"
              transition="all 0.1s"
              _hover={{ bg: 'rgba(248,81,73,0.1)' }}
              _active={{ transform: 'scale(0.9)' }}
              onClick={handleStop}
              aria-label="Stop agent (Esc)"
              title="Stop (Esc)"
            >
              <FiSquare size={10} />
            </Box>
          )}
        </Flex>
      </Flex>
    </>
  )
})
