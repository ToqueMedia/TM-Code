import { memo, useCallback, useEffect, useRef, useState } from 'react'
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

/** How long after mount before keyboard shortcuts take effect (ms). Mirrors
 *  TerminalPermissionPrompt — the card can appear mid-typing and a keystroke
 *  already in flight must not auto-fire an approve/reject the user never saw. */
const KEY_ARMING_MS = 350

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

  // ── Keyboard-first option model (mirrors TerminalPermissionPrompt) ──────────
  // Flat '>'-prefixed rows, single-key shortcuts, arrow/Enter navigation and a
  // KEY_ARMING_MS guard. Only the ACTIVE (pending) state wires keyboard; the
  // terminal states below render a static line and never reach this.
  const isActive = status !== 'approved' && status !== 'changes_requested' && status !== 'rejected'

  const options = [
    { shortcut: 'y', label: t('plan.approve'), color: tokens.colors.accent.greenBright, run: handleApprove },
    { shortcut: 'n', label: t('plan.reject'), color: tokens.colors.accent.red, run: handleReject },
    // 'v' = view full plan; 'c' = request changes. Both stay purple (structural),
    // red is reserved for the destructive reject above.
    { shortcut: 'v', label: t('plan.viewFull'), color: tokens.colors.accent.purple, run: handleViewPlan },
    { shortcut: 'c', label: t('plan.requestChanges'), color: tokens.colors.accent.purple, run: handleChanges },
  ]

  const [selected, setSelected] = useState(0)

  // Arming delay — see KEY_ARMING_MS. Keys are ignored until the card has been
  // visible long enough to be perceived; key-repeats are ignored too (Enter held
  // down from before the card appeared).
  const armedAtRef = useRef(0)
  useEffect(() => {
    armedAtRef.current = performance.now() + KEY_ARMING_MS
  }, [])

  // Window 'keydown' listener (added/removed here) — single-key shortcuts plus
  // arrow/Enter navigation. Mouse still works via each row's onClick.
  useEffect(() => {
    if (!isActive) return
    function handleKeyDown(e: KeyboardEvent) {
      if (performance.now() < armedAtRef.current || e.repeat) return
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return

      const key = e.key.toLowerCase()
      const direct = options.find((o) => o.shortcut === key)
      if (direct) {
        e.preventDefault()
        direct.run()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => (i >= options.length - 1 ? 0 : i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i <= 0 ? options.length - 1 : i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        options[selected]?.run()
      }
      // NB: no Escape branch. TerminalView owns Escape on a capture-phase window
      // listener that runs first (stop-agent / exit-to-welcome) and stops
      // propagation, so a card-level Escape would be dead in nearly every
      // context. Reject stays reachable via 'n' (and the bracketed [n] hint).
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, selected, handleApprove, handleReject, handleViewPlan, handleChanges])

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

      {/* Keyboard-first option rows — flat, '>'-prefixed, single-key shortcuts.
          Mouse still works: clicking a row runs its callback. */}
      <Flex direction="column" gap={0.5}>
        {options.map((opt, i) => (
          <PlanOptionRow
            key={opt.shortcut}
            shortcut={opt.shortcut}
            label={opt.label}
            color={opt.color}
            selected={i === selected}
            onClick={opt.run}
            onMouseEnter={() => setSelected(i)}
          />
        ))}
      </Flex>

      {/* Bare bracketed key hint, mono font, no filled pills. */}
      <Text
        fontSize="11px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        mt={2}
        userSelect="none"
      >
        [y] {t('plan.approve').toLowerCase()} · [n] {t('plan.reject').toLowerCase()} · [v] {t('plan.viewFull').toLowerCase()} · [c] {t('plan.requestChanges').toLowerCase()}
      </Text>
    </Box>
  )
})

/**
 * Flat keyboard-first option row mirroring TerminalPermissionPrompt's OptionRow:
 * a '>' marker + shortcut + label, no filled button, no radius>2px, no shadow.
 * The selected/armed row is tinted with the option's accent (purple structural,
 * red for the destructive reject). Mouse: click runs it, hover selects it.
 */
function PlanOptionRow({
  shortcut,
  label,
  color,
  selected,
  onClick,
  onMouseEnter,
}: {
  shortcut: string
  label: string
  color: string
  selected: boolean
  onClick: () => void
  onMouseEnter: () => void
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap={2}
      w="100%"
      minW={0}
      px={2}
      py={1}
      borderRadius={tokens.radius.sm}
      color={selected ? tokens.colors.text.primary : tokens.colors.text.secondary}
      bg={selected ? 'rgba(255,255,255,0.045)' : 'transparent'}
      border="1px solid"
      borderColor={selected ? `${color}66` : 'transparent'}
      textAlign="left"
      cursor="pointer"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      _hover={{
        bg: 'rgba(255,255,255,0.045)',
        color: tokens.colors.text.primary,
      }}
    >
      <Text color={color} fontSize="13px" fontWeight="800" flexShrink={0} lineHeight="1.4">
        &gt;
      </Text>
      <Text
        as="span"
        minW="20px"
        color={color}
        fontSize="12px"
        fontWeight="700"
        textAlign="center"
        lineHeight="1.4"
      >
        {shortcut}
      </Text>
      <Text
        as="span"
        color="inherit"
        fontSize="12px"
        fontFamily={tokens.fontFamily.mono}
        lineHeight="1.45"
        minW={0}
        overflowWrap="anywhere"
      >
        {label}
      </Text>
    </Flex>
  )
}
