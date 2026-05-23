import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useChatStore } from '../../stores/chatStore'
import { useEditorRepository } from '../../stores/editorStore'
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

  const [viewingPlan, setViewingPlan] = useState(false)
  const [planContent, setPlanContent] = useState<string>('')
  const [loadingPlan, setLoadingPlan] = useState(false)

  // Auto-remove after terminal state
  useEffect(() => {
    if (status !== 'approved' && status !== 'changes_requested' && status !== 'rejected') return
    const timer = setTimeout(() => {
      useChatStore.getState().removeMessage(messageId)
    }, 2500)
    return () => clearTimeout(timer)
  }, [status, messageId])

  const handleApprove = useCallback(async () => {
    useChatStore.getState().updateCardStatus(messageId, 'approved')
    await handlePlanApprove(projectPath)
  }, [messageId, projectPath])

  const handleChanges = useCallback(() => {
    useChatStore.getState().updateCardStatus(messageId, 'changes_requested')
    handlePlanRequestChanges(projectPath)
  }, [messageId, projectPath])

  const handleReject = useCallback(() => {
    useChatStore.getState().updateCardStatus(messageId, 'rejected')
    handlePlanReject()
  }, [messageId])

  const handleViewPlan = useCallback(async () => {
    if (viewingPlan) {
      setViewingPlan(false)
      return
    }
    const planPath = `${projectPath}/PLAN.md`
    try {
      setLoadingPlan(true)
      const content = await FileService.readFile(planPath)
      setPlanContent(content)
      setViewingPlan(true)
    } catch {
      useChatStore.getState().addSystemMessage(
        'PLAN.md is missing. Run /plan again to regenerate it.',
      )
    } finally {
      setLoadingPlan(false)
    }
  }, [projectPath, viewingPlan])

  const handleOpenInEditor = useCallback(() => {
    const planPath = `${projectPath}/PLAN.md`
    useEditorRepository.getState().openFile(planPath)
    useLayoutStore.getState().setViewMode('editor')
  }, [projectPath])

  // Keyboard: Enter=approve, Escape=reject (only when pending)
  useEffect(() => {
    if (status !== 'pending') return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        handleApprove()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleReject()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [status, handleApprove, handleReject])

  // ── Approved state ──
  if (status === 'approved') {
    return (
      <Box mb={3} py="2px" pl="6px">
        <Flex align="center" gap={1.5}>
          <Text fontSize="12px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            ✓
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
            ✎
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
            ✗
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

      {/* Plan preview (expandable) */}
      {viewingPlan && (
        <Box
          maxH="300px"
          overflowY="auto"
          bg="rgba(0, 0, 0, 0.3)"
          p={3}
          borderRadius="4px"
          mb={3}
          whiteSpace="pre-wrap"
          color="rgba(255, 255, 255, 0.6)"
          fontSize="12px"
          fontFamily={tokens.fontFamily.mono}
          lineHeight="1.5"
        >
          {planContent}
        </Box>
      )}

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
            {loadingPlan ? '...' : viewingPlan ? t('plan.hidePlan') ?? 'Hide Plan' : t('plan.viewFull')}
          </Text>
        </Flex>

        {/* Open in Editor */}
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
          onClick={handleOpenInEditor}
        >
          <Text fontSize="12px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} fontWeight="500">
            {t('plan.openInEditor') ?? 'Open in Editor'}
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

      {/* Key hints */}
      <Flex align="center" gap={3} mt={3} pt={2} borderTop="1px solid rgba(255, 255, 255, 0.06)">
        <Flex align="center" gap={1}>
          <Box
            as="span"
            px="5px"
            py="1px"
            borderRadius="3px"
            bg="rgba(255, 255, 255, 0.06)"
            border="1px solid rgba(255, 255, 255, 0.1)"
            fontSize="10px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.terminal.foreground}
            fontWeight="600"
          >
            ↵
          </Box>
          <Text fontSize="10px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            approve
          </Text>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
          ·
        </Text>
        <Flex align="center" gap={1}>
          <Box
            as="span"
            px="5px"
            py="1px"
            borderRadius="3px"
            bg="rgba(255, 255, 255, 0.06)"
            border="1px solid rgba(255, 255, 255, 0.1)"
            fontSize="10px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.terminal.foreground}
            fontWeight="600"
          >
            esc
          </Box>
          <Text fontSize="10px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            reject
          </Text>
        </Flex>
      </Flex>
    </Box>
  )
})
