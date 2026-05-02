import { memo } from 'react'
import { Flex, Text, Box } from '@chakra-ui/react'
import { FiSquare, FiCheckSquare, FiLoader } from 'react-icons/fi'
import { useAgentStore, type AgentTask } from '../../stores/agentStore'
import { useChatStore, resolveAllPendingDiffApprovals, selectLastCompletedToolName } from '../../stores/chatStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useAgentElapsed } from '../../hooks/useAgentElapsed'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useBillingStore, isInOverageState } from '../../stores/billingStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBackgroundAgentStore } from '../../stores/backgroundAgentStore'
import { getCommandQueueSnapshot } from '../../services/agent/messageQueue'
import { getProfileForPlan } from '../../services/agent/modelProfiles'
import AgentService from '../../services/agent/agentService'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

// formatTokens removed — token/credit display removed from status bar.

function formatElapsedShort(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

function AgentStatusBar() {
  const status = useAgentStore(s => s.status)
  const error = useAgentStore(s => s.error)
  const modelName = useAgentStore(s => s.modelName)
  const isStreaming = useChatStore(s => s.isStreaming)
  const lastTool = useChatStore(selectLastCompletedToolName)
  const skillCount = useSkillStore(s => s.skills.length)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const mcpServers = useMcpStore(s => s.servers)
  const totalMcpTools = useMcpStore(s => s.getTotalToolCount())
  const noCredits = useBillingStore(s => s.noCredits)
  const isActive = useBillingStore(s => s.isActive)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const billingStatus = useBillingStore(s => s.status)
  // Overage UI fires for either explicit overage status OR cycle exhausted (spillover)
  const usingTmsOverage = isInOverageState(billingStatus, consumedPct)
  const isBudgetBlocked = billingStatus === 'rejected'
  const bgAgents = useBackgroundAgentStore(s => s.agents)
  const agentTasks = useAgentStore(s => s.tasks)
  const queueLength = getCommandQueueSnapshot().length

  const handleStop = () => {
    usePermissionStore.getState().clearPending()
    usePermissionStore.getState().resetAutoApprove()
    resolveAllPendingDiffApprovals(false)
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }

  const statusConfig: Record<string, { color: string; label: string; pulse: boolean }> = {
    idle: { color: tokens.colors.text.disabled, label: t('chat.ready'), pulse: false },
    awaiting_response: { color: tokens.colors.toolCall.runningText, label: t('chat.awaitingResponse'), pulse: true },
    reasoning: { color: tokens.colors.accent.purple, label: t('chat.reasoning'), pulse: true },
    generating: { color: tokens.colors.accent.primary, label: t('chat.generating'), pulse: true },
    applying: { color: tokens.colors.accent.green, label: t('chat.applying'), pulse: true },
    compressing: { color: tokens.colors.accent.orange, label: t('chat.compressing'), pulse: true },
    error: { color: tokens.colors.accent.red, label: error || 'Error', pulse: false },
  }

  // Status priority: inactive > budget blocked > overage > no credits > agent status
  let config = (!isActive && status === 'idle')
    ? { color: tokens.colors.accent.red, label: t('chat.accountInactive'), pulse: false }
    : (isBudgetBlocked && status === 'idle')
    ? { color: tokens.colors.accent.red, label: t('chat.noCredits'), pulse: false }
    : (usingTmsOverage && status === 'idle')
    ? { color: tokens.colors.accent.orange, label: t('chat.usingTmsOverage'), pulse: false }
    : (noCredits && status === 'idle')
    ? { color: tokens.colors.accent.red, label: t('chat.noCredits'), pulse: false }
    : (statusConfig[status] || statusConfig.idle)

  // When awaiting a response after a tool just completed, swap the generic
  // "Awaiting response..." for "Processed {tool} — awaiting response..." so
  // the user gets a faithful read on what just happened. Only meaningful for
  // 'awaiting_response' (post-tool) — other states have their own narrative.
  if (status === 'awaiting_response' && lastTool) {
    config = { ...config, label: t('chat.processedTool').replace('{tool}', lastTool) }
  }

  // Per-phase elapsed timer. Pauses automatically when a permission dialog
  // is open (shared hook keeps all three timer surfaces aligned).
  const { elapsedMs, isPaused } = useAgentElapsed('phase')
  const isBusy = status !== 'idle' && status !== 'error'
  const showElapsed = isBusy && elapsedMs >= 5000
  // Thinking toggle — visibility driven by the BACKEND's authoritative answer
  // (X-Model-Thinking-Mode header on the last response). The frontend's
  // per-plan profile is only a pre-handshake fallback used before the first
  // response arrives. This eliminates the frontend↔backend drift that
  // happens when the admin changes a plan's ideModel in Firestore.
  // Hidden when the backend reports 'none' (e.g. mimo-v2-flash) or 'mandatory'
  // (always-on by design — toggle would be a no-op).
  const thinkingEnabled = useSettingsStore(s => s.thinkingEnabled)
  const toggleThinking = useSettingsStore(s => s.setThinkingEnabled)
  const backendThinkingMode = useAgentStore(s => s.thinkingMode)
  const billingPlan = useBillingStore(s => s.plan)
  const fallbackProfile = getProfileForPlan(billingPlan)
  const effectiveMode = backendThinkingMode
    ?? (fallbackProfile.supportsThinking
        ? (fallbackProfile.thinkingMode === 'mandatory' ? 'mandatory' : 'toggleable')
        : 'none')
  const thinkingSupported = effectiveMode === 'toggleable'
  const thinkingMandatory = effectiveMode === 'mandatory'
  const autoApproveDiffs = usePermissionStore(s => s.autoApproveDiffs)

  // Build info segments — derive counts from raw store data (avoids infinite re-render loop)
  const runningServers = mcpServers.filter(s => s.status === 'running')
  const bgTotal = bgAgents.size
  const bgRunning = Array.from(bgAgents.values()).filter(a => a.status === 'running').length

  const infoSegments: string[] = []
  if (modelName) infoSegments.push(modelName)
  if (autoApproveDiffs) infoSegments.push('⚡ Auto-approve ON')
  if (queueLength > 0) infoSegments.push(`${queueLength} queued`)
  if (skillCount > 0) infoSegments.push(`${skillCount} ${t("chat.skills")}`)
  if (mcpIsInitializing) {
    infoSegments.push(t('chat.mcpStarting'))
  } else if (runningServers.length > 0) {
    infoSegments.push(`${runningServers.length} MCP (${totalMcpTools} tools)`)
  }
  if (bgTotal > 0) {
    const bgDone = bgTotal - bgRunning
    const parts: string[] = []
    if (bgRunning > 0) parts.push(`${bgRunning} running`)
    if (bgDone > 0) parts.push(`${bgDone} done`)
    infoSegments.push(`bg: ${parts.join(', ')}`)
  }

  return (
    <Box borderTop="1px solid rgba(255, 255, 255, 0.04)" bg="rgba(255, 255, 255, 0.02)">
      {/* Agent task list — shows when agent has active tasks. Defensive
          Array.isArray guard: store should always hold an array, but a
          rogue setTasks(undefined) elsewhere shouldn't crash the chrome. */}
      {Array.isArray(agentTasks) && agentTasks.length > 0 && (
        <Box px={3} pt="6px" pb="4px" borderBottom="1px solid rgba(255, 255, 255, 0.04)">
          <Flex align="center" gap="6px" mb="4px">
            <FiCheckSquare size={10} color={tokens.colors.accent.purple} />
            <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.muted} letterSpacing="0.02em">
              {agentTasks.filter(t => t.status === 'completed').length}/{agentTasks.length} tasks
            </Text>
          </Flex>
          {agentTasks.map((task: AgentTask) => (
            <Flex key={task.id} align="center" gap="6px" py="2px" pl={1}>
              {task.status === 'completed' ? (
                <FiCheckSquare size={11} color={tokens.colors.accent.greenBright} style={{ flexShrink: 0 }} />
              ) : task.status === 'in_progress' ? (
                <Box as={FiLoader} boxSize="11px" color={tokens.colors.accent.primary} flexShrink={0} css={{
                  animation: 'taskSpin 1.5s linear infinite',
                  '@keyframes taskSpin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } },
                }} />
              ) : (
                <FiSquare size={11} color={tokens.colors.text.disabled} style={{ flexShrink: 0 }} />
              )}
              <Text
                fontSize="11px"
                color={task.status === 'completed' ? tokens.colors.text.muted : tokens.colors.text.primary}
                textDecoration={task.status === 'completed' ? 'line-through' : 'none'}
                lineHeight="1.4"
              >
                {task.description}
              </Text>
            </Flex>
          ))}
        </Box>
      )}
      {/* Status bar */}
      <Flex
        role="status"
        aria-live="polite"
        align="center"
        justify="space-between"
        px={3}
        py="6px"
        minH="28px"
      >
      <Flex align="center" gap={2}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={config.color}
          flexShrink={0}
          css={config.pulse ? {
            animation: 'statusPulse 1.5s ease-in-out infinite',
            '@keyframes statusPulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.3 },
            }
          } : undefined}
        />
        <Text fontSize="11px" color={tokens.colors.text.muted} letterSpacing="0.01em">
          {config.label}
        </Text>
        {showElapsed && (
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            letterSpacing="0.01em"
            ml="2px"
            title={isPaused ? 'Timer paused — awaiting your approval' : undefined}
          >
            {formatElapsedShort(elapsedMs)}{isPaused ? ' ⏸' : ''}
          </Text>
        )}
      </Flex>

      <Flex align="center" gap={3}>
        {/* Thinking — interactive toggle when the model supports on/off,
            static badge when it's always-on (mandatory). */}
        {thinkingSupported && (
          <Flex
            as="button"
            align="center"
            gap="4px"
            px="6px"
            py="2px"
            borderRadius="4px"
            cursor="pointer"
            bg={thinkingEnabled ? 'rgba(163, 113, 247, 0.1)' : 'transparent'}
            color={thinkingEnabled ? tokens.colors.accent.purple : tokens.colors.text.disabled}
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: thinkingEnabled ? 'rgba(163, 113, 247, 0.15)' : tokens.colors.bg.hoverSubtle }}
            onClick={() => toggleThinking(!thinkingEnabled)}
            title={thinkingEnabled ? 'Thinking ON (click to disable)' : 'Thinking OFF (click to enable)'}
          >
            <Text fontSize="10px" fontWeight="600" letterSpacing="0.02em">
              {thinkingEnabled ? '⚡ Thinking' : 'Thinking OFF'}
            </Text>
          </Flex>
        )}
        {thinkingMandatory && (
          <Flex
            align="center"
            gap="4px"
            px="6px"
            py="2px"
            borderRadius="4px"
            bg="rgba(163, 113, 247, 0.08)"
            color={tokens.colors.accent.purple}
            title="Thinking is always-on for this model"
          >
            <Text fontSize="10px" fontWeight="600" letterSpacing="0.02em">
              ⚡ Thinking
            </Text>
          </Flex>
        )}

        <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
          {infoSegments.join(' \u00B7 ')}
        </Text>

        {isStreaming && (
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="20px"
            h="20px"
            borderRadius="5px"
            bg="transparent"
            color={tokens.colors.accent.red}
            cursor="pointer"
            transition="all 0.12s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.1)' }}
            _active={{ transform: 'scale(0.9)' }}
            onClick={handleStop}
            aria-label={t("chat.stopGeneration")}
          >
            <FiSquare size={11} />
          </Box>
        )}
      </Flex>
    </Flex>
    </Box>
  )
}

export default memo(AgentStatusBar)
