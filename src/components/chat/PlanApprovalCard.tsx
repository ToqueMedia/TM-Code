import { memo, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiFileText, FiCheck, FiEdit2, FiX } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { handlePlanApprove, handlePlanRequestChanges, handlePlanReject } from '../../services/agent/commands/planCommand'
import { FileService } from '../../services/fileService'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { ChatMessageCard } from '../../types/chat'

interface PlanApprovalCardProps {
  messageId: string
  card: ChatMessageCard
}

function PlanApprovalCard({ messageId, card }: PlanApprovalCardProps) {
  const { projectPath, status } = card

  const handleApprove = useCallback(async () => {
    useLayoutStore.getState().setPlanViewerOpen(false)
    useChatStore.getState().updateCardStatus(messageId, 'approved')
    await handlePlanApprove(projectPath)
  }, [messageId, projectPath])

  const handleChanges = useCallback(() => {
    useLayoutStore.getState().setPlanViewerOpen(false)
    useChatStore.getState().updateCardStatus(messageId, 'changes_requested')
    handlePlanRequestChanges(projectPath)
  }, [messageId, projectPath])

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
    const planPath = `${projectPath}/PLAN.md`
    try {
      await FileService.readFile(planPath)
    } catch {
      useChatStore.getState().addSystemMessage(
        'PLAN.md is missing. Run /plan again to regenerate it.',
      )
      return
    }
    layout.setPlanViewerOpen(true)
  }, [projectPath])

  return (
    <Box
      bg="rgba(255, 255, 255, 0.03)"
      border="1px solid rgba(255, 255, 255, 0.08)"
      borderRadius="12px"
      p={4}
      my={2}
    >
      {/* Header */}
      <Flex align="center" gap={2} mb={3}>
        <Flex
          w="24px"
          h="24px"
          borderRadius="6px"
          bg="rgba(163, 113, 247, 0.15)"
          align="center"
          justify="center"
          flexShrink={0}
        >
          <FiFileText size={12} color={tokens.colors.accent.purple} />
        </Flex>
        <Text
          fontSize="13.5px"
          fontWeight="600"
          color={tokens.colors.text.primary}
          letterSpacing="-0.01em"
        >
          {t("plan.readyForReview")}
        </Text>
      </Flex>

      <Text
        fontSize="12.5px"
        color={tokens.colors.text.secondary}
        mb={4}
        lineHeight="1.6"
      >
        {t("plan.description")}
      </Text>

      {/* View Plan button */}
      <Flex
        as="button"
        align="center"
        gap="6px"
        px={3}
        py="7px"
        mb={3}
        borderRadius="8px"
        bg="rgba(255, 255, 255, 0.05)"
        border="1px solid rgba(255, 255, 255, 0.08)"
        cursor="pointer"
        transition="all 0.15s"
        _hover={{ bg: 'rgba(255, 255, 255, 0.08)' }}
        onClick={handleViewPlan}
      >
        <FiFileText size={12} color={tokens.colors.text.secondary} />
        <Text fontSize="12px" color={tokens.colors.text.primary}>
          {t("plan.viewFull")}
        </Text>
      </Flex>

      {/* Action buttons or status */}
      {status === 'pending' && (
        <Flex gap={2} flexWrap="wrap">
          <Flex
            as="button"
            align="center"
            gap="5px"
            px={3}
            py="7px"
            borderRadius="8px"
            bg="rgba(46, 160, 67, 0.12)"
            border="1px solid rgba(46, 160, 67, 0.25)"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(46, 160, 67, 0.2)' }}
            onClick={handleApprove}
          >
            <FiCheck size={12} color={tokens.colors.accent.greenBright} />
            <Text fontSize="12px" color={tokens.colors.accent.greenBright} fontWeight="500">
              Approve
            </Text>
          </Flex>

          <Flex
            as="button"
            align="center"
            gap="5px"
            px={3}
            py="7px"
            borderRadius="8px"
            bg="rgba(247, 127, 0, 0.1)"
            border="1px solid rgba(247, 127, 0, 0.25)"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(247, 127, 0, 0.18)' }}
            onClick={handleChanges}
          >
            <FiEdit2 size={11} color={tokens.colors.accent.orange} />
            <Text fontSize="12px" color={tokens.colors.accent.orange} fontWeight="500">
              {t("plan.requestChanges")}
            </Text>
          </Flex>

          <Flex
            as="button"
            align="center"
            gap="5px"
            px={3}
            py="7px"
            borderRadius="8px"
            bg="rgba(248, 81, 73, 0.08)"
            border="1px solid rgba(248, 81, 73, 0.2)"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.15)' }}
            onClick={handleReject}
          >
            <FiX size={12} color={tokens.colors.accent.red} />
            <Text fontSize="12px" color={tokens.colors.accent.red} fontWeight="500">
              Reject
            </Text>
          </Flex>
        </Flex>
      )}

      {status === 'approved' && (
        <StatusBadge color={tokens.colors.accent.greenBright} bg="rgba(46, 160, 67, 0.1)" label={t('plan.approved')} />
      )}
      {status === 'changes_requested' && (
        <StatusBadge color={tokens.colors.accent.orange} bg="rgba(247, 127, 0, 0.1)" label={t('plan.changesRequested')} />
      )}
      {status === 'rejected' && (
        <StatusBadge color={tokens.colors.accent.red} bg="rgba(248, 81, 73, 0.1)" label={t('plan.rejected')} />
      )}
    </Box>
  )
}

function StatusBadge({ color, bg, label }: { color: string; bg: string; label: string }) {
  return (
    <Flex
      display="inline-flex"
      align="center"
      gap="5px"
      px="10px"
      py="5px"
      borderRadius="6px"
      bg={bg}
    >
      <Box w="6px" h="6px" borderRadius="full" bg={color} />
      <Text fontSize="12px" color={color} fontWeight="500">{label}</Text>
    </Flex>
  )
}

export default memo(PlanApprovalCard)
