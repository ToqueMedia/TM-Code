import { memo } from 'react'
import { Flex, Text, Box } from '@chakra-ui/react'
import { FiSquare, FiBox, FiShield, FiCheckSquare, FiLoader } from 'react-icons/fi'
import { useAgentStore, type AgentTask } from '../../stores/agentStore'
import { useChatStore, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useContainerStore } from '../../stores/containerStore'
import { useBillingStore, getEffectiveUtilization } from '../../stores/billingStore'
import { useBackgroundAgentStore } from '../../stores/backgroundAgentStore'
import AgentService from '../../services/agent/agentService'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  if (count < 1_000_000) {
    const k = count / 1000
    return k >= 100 ? `${Math.round(k)}k` : k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
  }
  const m = count / 1_000_000
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
}

function AgentStatusBar() {
  const status = useAgentStore(s => s.status)
  const error = useAgentStore(s => s.error)
  const isStreaming = useChatStore(s => s.isStreaming)
  const totalTokensUsed = useChatStore(s => s.totalTokensUsed)
  const currentTurnCount = useChatStore(s => s.currentTurnCount)
  const skillCount = useSkillStore(s => s.skills.length)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const runningServers = useMcpStore(s => s.getRunningServers())
  const totalMcpTools = useMcpStore(s => s.getTotalToolCount())
  const isolationMode = useContainerStore(s => s.isolationMode)
  const billingPlan = useBillingStore(s => s.plan)
  const noCredits = useBillingStore(s => s.noCredits)
  const raw5hUtil = useBillingStore(s => s.envelope5hUtilization)
  const envelope5hReset = useBillingStore(s => s.envelope5hReset)
  const raw7dUtil = useBillingStore(s => s.envelope7dUtilization)
  const envelope7dReset = useBillingStore(s => s.envelope7dReset)
  const envelope5hUtil = getEffectiveUtilization(raw5hUtil, envelope5hReset)
  const envelope7dUtil = getEffectiveUtilization(raw7dUtil, envelope7dReset)
  const envelopeStatus = useBillingStore(s => s.envelopeStatus)
  const tmsStatus = useBillingStore(s => s.tmsStatus)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const usingTmsOverage = useBillingStore(s => s.usingTmsOverage)
  const representativeClaim = useBillingStore(s => s.representativeClaim)
  const queuePosition = useAgentStore(s => s.queuePosition)
  const bgRunning = useBackgroundAgentStore(s => s.getRunningCount())
  const bgTotal = useBackgroundAgentStore(s => s.getAll().length)
  const agentTasks = useAgentStore(s => s.tasks)

  const handleStop = () => {
    usePermissionStore.getState().clearPending()
    resolveAllPendingDiffApprovals(false)
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }

  const statusConfig: Record<string, { color: string; label: string; pulse: boolean }> = {
    idle: { color: tokens.colors.text.disabled, label: t('chat.ready'), pulse: false },
    thinking: { color: tokens.colors.toolCall.runningText, label: t('chat.thinking'), pulse: true },
    generating: { color: tokens.colors.accent.primary, label: t('chat.generating'), pulse: true },
    applying: { color: tokens.colors.accent.green, label: t('chat.applying'), pulse: true },
    compressing: { color: tokens.colors.accent.orange, label: t('chat.compressing'), pulse: true },
    error: { color: tokens.colors.accent.red, label: error || 'Error', pulse: false },
  }

  // Status priority: queue > envelope exhausted > no credits > agent status
  const isEnvelopeBlocked = envelopeStatus === 'rejected' && tmsStatus === 'rejected'
  const blockedLabel = representativeClaim === 'monthly'
    ? t('chat.noTokens') + ' (mensal)'
    : representativeClaim === '7d'
    ? t('chat.noTokens') + ' (7d)'
    : t('chat.noTokens') + ' (5h)'
  const config = queuePosition
    ? { color: tokens.colors.accent.orange, label: `${t('chat.inQueue')}: ${queuePosition.position} / ${queuePosition.total}`, pulse: true }
    : (isEnvelopeBlocked && status === 'idle')
    ? { color: tokens.colors.accent.red, label: blockedLabel, pulse: false }
    : (usingTmsOverage && status === 'idle')
    ? { color: tokens.colors.accent.orange, label: t('chat.usingTmsOverage'), pulse: false }
    : (noCredits && status === 'idle')
    ? { color: tokens.colors.accent.red, label: t('chat.noCredits'), pulse: false }
    : (statusConfig[status] || statusConfig.idle)
  const totalTokens = totalTokensUsed.input + totalTokensUsed.output

  // Build info segments — show usage % (0→100 as tokens are consumed)
  const infoSegments: string[] = []
  const h5Used = Math.round(envelope5hUtil * 100)
  const d7Used = Math.round(envelope7dUtil * 100)
  // Only show window % when session is active (has reset epoch)
  if (envelope5hReset > 0) infoSegments.push(`5h: ${h5Used}%`)
  if (envelope7dReset > 0) infoSegments.push(`7d: ${d7Used}%`)
  if (usingTmsOverage) {
    infoSegments.push(`TMS: ${tmsRemaining}`)
  }
  if (billingPlan) {
    infoSegments.push(billingPlan)
  }
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
  infoSegments.push(`${t('chat.session')}: ${formatTokens(totalTokens)}`)
  infoSegments.push(`${currentTurnCount} turns`)

  const isolationBadge = isolationMode === 'docker'
    ? { icon: FiBox, label: t('chat.dockerIsolation'), color: tokens.colors.accent.greenBright, bg: tokens.colors.accent.greenSubtle }
    : isolationMode === 'app-level'
    ? { icon: FiShield, label: t('chat.appIsolation'), color: '#58a6ff', bg: 'rgba(56, 139, 253, 0.12)' }
    : null

  return (
    <Box borderTop="1px solid rgba(255, 255, 255, 0.04)" bg="rgba(255, 255, 255, 0.02)">
      {/* Agent task list — shows when agent has active tasks */}
      {agentTasks.length > 0 && (
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

        {isolationBadge && (
          <Flex
            align="center"
            gap="4px"
            px="6px"
            py="1px"
            ml={1}
            borderRadius="3px"
            bg={isolationBadge.bg}
            title={isolationMode === 'docker'
              ? t('chat.dockerTooltip')
              : t('chat.appTooltip')
            }
          >
            <isolationBadge.icon size={9} color={isolationBadge.color} />
            <Text fontSize="10px" fontWeight="600" color={isolationBadge.color} letterSpacing="0.02em">
              {isolationBadge.label}
            </Text>
          </Flex>
        )}
      </Flex>

      <Flex align="center" gap={3}>
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
