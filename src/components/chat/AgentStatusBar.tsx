import { memo } from 'react'
import { Flex, Text, Box } from '@chakra-ui/react'
import { FiSquare, FiBox, FiShield } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useContainerStore } from '../../stores/containerStore'
import { useBillingStore } from '../../stores/billingStore'
import { useBackgroundAgentStore } from '../../stores/backgroundAgentStore'
import AgentService from '../../services/agent/agentService'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}K`
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
  const envelope5hUtil = useBillingStore(s => s.envelope5hUtilization)
  const envelope7dUtil = useBillingStore(s => s.envelope7dUtilization)
  const envelopeStatus = useBillingStore(s => s.envelopeStatus)
  const tmsStatus = useBillingStore(s => s.tmsStatus)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const usingTmsOverage = useBillingStore(s => s.usingTmsOverage)
  const representativeClaim = useBillingStore(s => s.representativeClaim)
  const queuePosition = useAgentStore(s => s.queuePosition)
  const bgRunning = useBackgroundAgentStore(s => s.getRunningCount())
  const bgTotal = useBackgroundAgentStore(s => s.getAll().length)

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

  // Build info segments — show envelope utilization instead of raw credits
  const infoSegments: string[] = []
  const h5Pct = Math.round(envelope5hUtil * 100)
  const d7Pct = Math.round(envelope7dUtil * 100)
  infoSegments.push(`5h: ${h5Pct}%`)
  infoSegments.push(`7d: ${d7Pct}%`)
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
  infoSegments.push(`${formatTokens(totalTokens)} tokens`)
  infoSegments.push(`${currentTurnCount} turns`)

  const isolationBadge = isolationMode === 'docker'
    ? { icon: FiBox, label: t('chat.dockerIsolation'), color: tokens.colors.accent.greenBright, bg: tokens.colors.accent.greenSubtle }
    : isolationMode === 'app-level'
    ? { icon: FiShield, label: t('chat.appIsolation'), color: '#58a6ff', bg: 'rgba(56, 139, 253, 0.12)' }
    : null

  return (
    <Flex
      role="status"
      aria-live="polite"
      align="center"
      justify="space-between"
      px={3}
      py="6px"
      bg="rgba(255, 255, 255, 0.02)"
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
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
  )
}

export default memo(AgentStatusBar)
