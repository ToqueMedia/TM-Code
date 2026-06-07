import { memo, useCallback, useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { handlePlanApprove, handlePlanRequestChanges, handlePlanReject } from '../../services/agent/commands/planCommand'
import { FileService } from '../../services/fileService'
import { t } from '@/i18n'
import type { ChatMessageCard } from '../../types/chat'

interface TerminalPlanApprovalCardProps {
  messageId: string
  card: ChatMessageCard
}

export const TerminalPlanApprovalCard = memo(function TerminalPlanApprovalCard({
  messageId,
  card,
}: TerminalPlanApprovalCardProps) {
  const { projectPath, status } = card
  const planPath = card.planPath ?? `${projectPath}/PLAN.md`
  const planFileName = card.planFileName ?? 'PLAN.md'

  // Auto-remove after terminal state
  useEffect(() => {
    if (status !== 'approved' && status !== 'changes_requested' && status !== 'rejected') return
    const timer = setTimeout(() => {
      useChatStore.getState().removeMessage(messageId)
    }, 2500)
    return () => clearTimeout(timer)
  }, [status, messageId])

  const handleApprove = useCallback(async () => {
    useLayoutStore.getState().setPlanViewerOpen(false)
    useChatStore.getState().updateCardStatus(messageId, 'approved')
    try {
      await handlePlanApprove(projectPath, planPath)
    } catch {
      useChatStore.getState().updateCardStatus(messageId, 'pending')
      useChatStore.getState().addSystemMessage(
        t('plan.approveError') ?? 'Failed to approve plan. Try again.',
      )
    }
  }, [messageId, projectPath, planPath])

  const handleChanges = useCallback(() => {
    useLayoutStore.getState().setPlanViewerOpen(false)
    useChatStore.getState().updateCardStatus(messageId, 'changes_requested')
    handlePlanRequestChanges(projectPath, planPath)
  }, [messageId, projectPath, planPath])

  const handleReject = useCallback(() => {
    useLayoutStore.getState().setPlanViewerOpen(false)
    useChatStore.getState().updateCardStatus(messageId, 'rejected')
    handlePlanReject()
  }, [messageId])

  const handleViewPlan = useCallback(async () => {
    const layout = useLayoutStore.getState()
    if (layout.isPlanViewerOpen) {
      layout.setPlanViewerOpen(false)
      return
    }
    try {
      await FileService.readFile(planPath)
    } catch {
      useChatStore.getState().addSystemMessage(
        t('plan.missing') ?? `${planFileName} is missing. Run /plan again to regenerate it.`,
      )
      return
    }
    layout.setPlanViewerOpen(true, planPath)
  }, [planPath, planFileName])

  // ── Approved state ──
  if (status === 'approved') {
    return (
      <Box mb={3} py="2px" pl="6px">
        <Flex align="center" gap={1.5}>
          <Text fontSize="12px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            [OK]
          </Text>
          <Text fontSize="13px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono}>
            {t('plan.approved')}
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Changes requested state ──
  if (status === 'changes_requested') {
    return (
      <Box mb={3} py="2px" pl="6px">
        <Flex align="center" gap={1.5}>
          <Text fontSize="12px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            [~]
          </Text>
          <Text fontSize="13px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono}>
            {t('plan.changesRequested')}
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Rejected state ──
  if (status === 'rejected') {
    return (
      <Box mb={3} py="2px" pl="6px">
        <Flex align="center" gap={1.5}>
          <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            [x]
          </Text>
          <Text fontSize="13px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            {t('plan.rejected')}
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Active card ──
  return (
    <Box
      mb={3}
      borderLeft={`2px solid ${tokens.colors.accent.purple}`}
      pl={3}
      py={2}
    >
      {/* Header */}
      <Flex align="center" gap={2} mb={1}>
        <Text
          fontSize="11px"
          color={tokens.colors.accent.purple}
          fontFamily={tokens.fontFamily.mono}
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.06em"
        >
          {t('plan.readyForReview')}
        </Text>
      </Flex>

      <Text
        fontSize="12px"
        color={tokens.colors.text.muted}
        fontFamily={tokens.fontFamily.mono}
        mb={3}
        lineHeight="1.5"
      >
        {t('plan.description')}
      </Text>

      {/* Action buttons */}
      <Flex gap={2} flexWrap="wrap">
        {/* Approve */}
        <Flex
          as="button"
          align="center"
          gap="5px"
          px={3}
          py="5px"
          borderRadius="4px"
          bg="rgba(46, 160, 67, 0.12)"
          border="1px solid rgba(46, 160, 67, 0.25)"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: 'rgba(46, 160, 67, 0.2)' }}
          onClick={handleApprove}
        >
          <Text fontSize="12px" color={tokens.colors.accent.greenBright} fontFamily={tokens.fontFamily.mono} fontWeight="500">
            {t('plan.approve')}
          </Text>
        </Flex>

        {/* Reject */}
        <Flex
          as="button"
          align="center"
          gap="5px"
          px={3}
          py="5px"
          borderRadius="4px"
          bg="rgba(248, 81, 73, 0.08)"
          border="1px solid rgba(248, 81, 73, 0.2)"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: 'rgba(248, 81, 73, 0.15)' }}
          onClick={handleReject}
        >
          <Text fontSize="12px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono} fontWeight="500">
            {t('plan.reject')}
          </Text>
        </Flex>

        {/* View Plan */}
        <Flex
          as="button"
          align="center"
          gap="5px"
          px={3}
          py="5px"
          borderRadius="4px"
          bg="rgba(255, 255, 255, 0.05)"
          border="1px solid rgba(255, 255, 255, 0.08)"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: 'rgba(255, 255, 255, 0.08)' }}
          onClick={handleViewPlan}
        >
          <Text fontSize="12px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} fontWeight="500">
            {t('plan.viewFull')}
          </Text>
        </Flex>

        {/* Request Changes */}
        <Flex
          as="button"
          align="center"
          gap="5px"
          px={3}
          py="5px"
          borderRadius="4px"
          bg="rgba(247, 127, 0, 0.1)"
          border="1px solid rgba(247, 127, 0, 0.25)"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: 'rgba(247, 127, 0, 0.18)' }}
          onClick={handleChanges}
        >
          <Text fontSize="12px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} fontWeight="500">
            {t('plan.requestChanges')}
          </Text>
        </Flex>
      </Flex>
    </Box>
  )
})
