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
import { FiArrowDown, FiArrowUp, FiCheck, FiLoader, FiSquare } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useAgentStore, type AgentTask } from '../../stores/agentStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSkillStore } from '../../stores/skillStore'
import { useBillingStore } from '../../stores/billingStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useBackgroundCommandStore } from '../../stores/backgroundCommandStore'
import { stopAgent } from '../../services/agent/cmdModeCommands'
import { getCommandQueueSnapshot, subscribeToCommandQueue } from '../../services/agent/messageQueue'
import { usePreflightStatus } from '../../hooks/usePreflightStatus'
import { countAvailable } from '../../services/preflightService'
import { getProfileForPlan, MODEL_PROFILES } from '../../services/agent/modelProfiles'
import { getAutoCompactThreshold, getEffectiveContextWindowSize } from '../../utils/contextWindow'
import { computeSlidingWindow } from '../../utils/taskWindow'
import { tokens } from '@/theme/tokens'
import { formatElapsed, formatTokens } from './terminalHelpers'

export const TerminalStatusLine = memo(function TerminalStatusLine() {
  const status = useAgentStore(s => s.status)
  const error = useAgentStore(s => s.error)
  const isStreaming = useChatStore(s => s.isStreaming)
  const totalTokensUsed = useChatStore(s => s.totalTokensUsed)
  // currentPromptTokens is the per-turn input on the wire (input +
  // cache_read + cache_creation). Same value the ContextWindowIndicator
  // reads — keeps the terminal ctx % in lockstep with the chat-mode pill.
  const currentPromptTokens = useChatStore((s) => {
    if (s.currentPromptTokens > 0) return s.currentPromptTokens
    if (!s.activeSessionId) return 0
    return s.sessions.get(s.activeSessionId)?.lastPromptTokens ?? 0
  })
  const headerContextWindow = useAgentStore(s => s.modelContextWindow)
  const modelName = useAgentStore(s => s.modelName)
  const agentTasks = useAgentStore(s => s.tasks)
  const skillCount = useSkillStore(s => s.skills.length)
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const totalMcpTools = useMcpStore(s => s.getTotalToolCount())
  const autoApproveDiffs = usePermissionStore(s => s.autoApproveDiffs)
  const queuedCommands = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
  const queueLength = queuedCommands.length
  const preflight = usePreflightStatus()
  const devServer = useLayoutStore(s => s.devServer)
  const bgCommands = useBackgroundCommandStore(s => s.commands)

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
      case 'compressing':       return { color: tokens.colors.accent.orange,        label: 'compacting', pulse: true }
      case 'error':             return { color: tokens.colors.accent.red,           label: error || 'error', pulse: false }
      default:                  return { color: tokens.colors.text.disabled,        label: 'ready', pulse: false }
    }
  }, [status, error])

  // Up = context size on the wire (input is replaced with max across turns).
  // Down = output emitted by model (sums across turns). Historically shown as
  // two separate counters with directional arrows. UX request 2026-05-12:
  // present as a single combined number so the user sees "total traffic" at a
  // glance — the directional split is still derivable from the colour cue
  // (orange = sending, green = generating, grey = idle).
  const inputTok = totalTokensUsed.input
  const outputTok = totalTokensUsed.output
  const combinedTok = inputTok + outputTok
  const isSending = status === 'awaiting_response' || status === 'compressing'
  const isReceiving = status === 'generating' || status === 'reasoning' || status === 'applying'

  // Context-window percentage for the active model. Same telemetry as the
  // ContextWindowIndicator in ChatView, rendered terminal-style (text only,
  // no progress bar) to fit CMD mode's monospace aesthetic.
  //
  // Source of truth matches the chat-mode pill:
  //   • currentPromptTokens (replaced per turn) — NOT totalTokensUsed.input,
  //     which is MAX across turns of the current request and inflates after
  //     compaction shrinks the prompt mid-loop.
  //   • headerContextWindow (X-Model-Context-Window) — falls back to the
  //     plan profile only pre-handshake.
  //   • Denominator is EFFECTIVE window (raw − 20K summary headroom),
  //     matching claude-vaz's calculateContextPercentages.
  const billingPlan = useBillingStore((s) => s.plan)
  const activeProfile = useMemo(() => {
    if (modelName && MODEL_PROFILES[modelName]) {
      return MODEL_PROFILES[modelName]
    }
    return getProfileForPlan(billingPlan)
  }, [modelName, billingPlan])
  const rawContextWindow = headerContextWindow ?? activeProfile.contextWindow ?? 0
  const effectiveWindow = getEffectiveContextWindowSize(rawContextWindow)
  const compactThreshold = getAutoCompactThreshold(rawContextWindow)
  const ctxPct = effectiveWindow > 0 && currentPromptTokens > 0
    ? Math.min(100, (currentPromptTokens / effectiveWindow) * 100)
    : 0
  const compactImminent = currentPromptTokens >= compactThreshold && currentPromptTokens > 0
  const ctxColor =
    compactImminent ? tokens.colors.accent.red
    : ctxPct < 70 ? tokens.colors.text.disabled
    : ctxPct < 90 ? tokens.colors.accent.orange
    : tokens.colors.accent.red
  const ctxTooltip = ctxPct > 0
    ? `Context: ${currentPromptTokens.toLocaleString()} / ${effectiveWindow.toLocaleString()} effective (${ctxPct.toFixed(1)}%) — ${activeProfile.name}${compactImminent ? ' · auto-compact next turn' : ''}`
    : undefined

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
    if (devServer && devServer.status !== 'stopped') {
      const url = devServer.frontendUrl || devServer.backendUrl
      const port = url?.match(/:(\d+)/)?.[1]
      out.push(port ? `dev :${port}` : devServer.status === 'starting' ? 'dev…' : 'dev')
    }
    // Background commands
    const bgCmdRunning = Array.from(bgCommands.values()).filter(c => c.status === 'running').length
    const bgCmdCompleted = Array.from(bgCommands.values()).filter(c => c.status === 'completed').length
    const bgCmdErrored = Array.from(bgCommands.values()).filter(c => c.status === 'error').length
    if (bgCmdRunning > 0 || bgCmdCompleted > 0 || bgCmdErrored > 0) {
      const parts: string[] = []
      if (bgCmdRunning > 0) parts.push(`${bgCmdRunning} running`)
      if (bgCmdCompleted > 0) parts.push(`${bgCmdCompleted} done`)
      if (bgCmdErrored > 0) parts.push(`${bgCmdErrored} err`)
      out.push(`cmds: ${parts.join(' ')}`)
    }
    return out
  }, [autoApproveDiffs, queueLength, skillCount, mcpIsInitializing, mcpServers, totalMcpTools, devServer, bgCommands])

  // Same auto-hide rule the chat-mode AgentTasksPanel uses: once the agent
  // finishes AND every task is completed, stop rendering the strip. This
  // also stops the chat-mode task list from leaking into CMD mode when the
  // user toggles modes mid-session — both surfaces share the same
  // agentStore.tasks slice but neither should render a stale "all done"
  // recap unprompted.
  const hasOngoingTasks = agentTasks.some((t: AgentTask) => t.status !== 'completed') || isStreaming
  const showTasks = agentTasks.length > 0 && hasOngoingTasks

  return (
    <>
      {/* Agent task list — 3-task sliding window, same UX as chat-mode AgentTasksPanel */}
      {showTasks && (() => {
        const completed = agentTasks.filter((t: AgentTask) => t.status === 'completed').length
        const inProgressIdx = agentTasks.findIndex((t: AgentTask) => t.status === 'in_progress')
        const firstPendingIdx = agentTasks.findIndex((t: AgentTask) => t.status === 'pending')
        const anchorIdx =
          inProgressIdx !== -1 ? inProgressIdx
          : firstPendingIdx !== -1 ? firstPendingIdx
          : -1
        const { start, end, hiddenAbove, hiddenBelow } =
          computeSlidingWindow(agentTasks.length, anchorIdx)
        const visible = agentTasks.slice(start, end + 1)

        return (
          <Box
            px={3}
            pt={1.5}
            pb={1}
            borderTop="1px solid rgba(255,255,255,0.04)"
            bg="rgba(0,0,0,0.1)"
          >
            <Text
              fontSize="13px"
              fontWeight="700"
              color={tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
              textTransform="uppercase"
              letterSpacing="0.1em"
              mb="4px"
            >
              {completed}/{agentTasks.length} tasks
            </Text>
            {hiddenAbove > 0 && (
              <Text fontSize="13px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} py="1px">
                · {hiddenAbove} earlier {hiddenAbove === 1 ? 'task' : 'tasks'}
              </Text>
            )}
            {visible.map((task: AgentTask) => (
              <Flex key={task.id} align="center" gap={2} py="2px">
                {task.status === 'completed' ? (
                  <FiCheck size={13} color={tokens.colors.accent.green} style={{ flexShrink: 0 }} />
                ) : task.status === 'in_progress' ? (
                  <Box
                    as={FiLoader}
                    boxSize="13px"
                    color={tokens.colors.accent.purple}
                    flexShrink={0}
                    css={{
                      animation: 'taskSpin 1.5s linear infinite',
                      '@keyframes taskSpin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } },
                    }}
                  />
                ) : (
                  <Box w="13px" h="13px" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
                    <Box w="4px" h="4px" borderRadius="full" bg={tokens.colors.text.disabled} />
                  </Box>
                )}
                <Text
                  fontSize="13px"
                  color={task.status === 'completed' ? tokens.colors.text.disabled : tokens.colors.text.secondary}
                  textDecoration={task.status === 'completed' ? 'line-through' : 'none'}
                  fontFamily={tokens.fontFamily.mono}
                  lineHeight="1.4"
                >
                  {task.description}
                </Text>
              </Flex>
            ))}
            {hiddenBelow > 0 && (
              <Text fontSize="13px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} py="1px">
                · {hiddenBelow} more {hiddenBelow === 1 ? 'task' : 'tasks'}
              </Text>
            )}
          </Box>
        )
      })()}

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
            fontSize="13px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="600"
          >
            {cfg.label}
          </Text>

          {segments.length > 0 && (
            <Text fontSize="13px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              {segments.join(' · ')}
            </Text>
          )}

          {toolkit && (
            <Text
              fontSize="13px"
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
          {(isStreaming || ctxPct > 0) && (
            <Text fontSize="13px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} whiteSpace="nowrap" title={ctxTooltip}>
              {isStreaming && formatElapsed(elapsed)}
              {ctxPct > 0 && (
                <>
                  {isStreaming && ' · '}
                  <Text as="span" color={ctxColor}>
                    {`ctx ${Math.round(ctxPct)}%`}
                  </Text>
                </>
              )}
              {isStreaming && combinedTok > 0 && (
                <>
                  {' · '}
                  {isSending && (
                    <Box
                      as="span"
                      display="inline-flex"
                      alignItems="center"
                      color={tokens.colors.accent.orange}
                      mr="3px"
                      verticalAlign="-2px"
                    >
                      <FiArrowUp size={10} strokeWidth={2.5} />
                    </Box>
                  )}
                  {isReceiving && (
                    <Box
                      as="span"
                      display="inline-flex"
                      alignItems="center"
                      color={tokens.colors.accent.green}
                      mr="3px"
                      verticalAlign="-2px"
                    >
                      <FiArrowDown size={10} strokeWidth={2.5} />
                    </Box>
                  )}
                  {formatTokens(combinedTok)}
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
