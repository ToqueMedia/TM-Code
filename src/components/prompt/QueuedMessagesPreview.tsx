/**
 * Queued Messages Preview — the stack fused on top of the composer.
 *
 * Renders as a connected extension of the input box (shared border, no gap,
 * square corners at the seam): the queue is "part of the prompt" until it
 * drains, not a floating strip. PromptBar square-rounds the input's top
 * corners while this component renders (see useHasQueuedForActiveSession).
 *
 * Two kinds of entries share the stack, with distinct semantics and visuals:
 *  - STEER (default, pink) — joins the RUNNING task at its next turn
 *    boundary (drained by the steering collectors mid-run).
 *  - TASK (`asTask`, purple) — waits for the current run to END, then the
 *    idle drain (queueProcessor) starts it as its OWN run, one at a time.
 *
 * Every entry can be removed or EDITED — editing pops it back into the
 * textarea (text + attachments) and takes it out of the queue. With 2+
 * entries they can be reordered — queue order is execution order (the idle
 * drain respects it, and the batch drain never crosses a task boundary).
 */

import { memo, useCallback, useSyncExternalStore } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronDown, FiChevronUp, FiCornerDownRight, FiEdit2, FiLayers, FiPause, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import {
  getCommandQueueSnapshot,
  isQueuePaused,
  moveInQueue,
  remove as removeFromQueue,
  setQueuePaused,
  subscribeToCommandQueue,
  subscribeToQueuePause,
} from '@/services/agent/messageQueue'
import { useChatStore } from '@/stores/chatStore'
import type { Attachment } from '@/types/chat'
import type { PromptValue, QueuedCommand } from '@/types/messageQueueTypes'

/**
 * Render a queued command's value as a single-line preview string.
 * Strings pass through; block arrays show their joined text plus an
 * "[N attached]" suffix when they carry attachments.
 */
function previewText(value: PromptValue): string {
  if (typeof value === 'string') return value
  const texts: string[] = []
  let attachmentCount = 0
  for (const block of value) {
    if (block.type === 'text') texts.push(block.text)
    else attachmentCount++
  }
  const joined = texts.join(' ')
  if (attachmentCount === 0) return joined
  const suffix = `[${attachmentCount} attached]`
  return joined.length > 0 ? `${joined} ${suffix}` : suffix
}

function kindOf(cmd: QueuedCommand): { color: string; icon: typeof FiLayers; badge: string; tooltip: string } {
  if (cmd.asTask === true) {
    return {
      color: tokens.colors.accent.purple,
      icon: FiLayers,
      badge: t('queue.badgeTask'),
      tooltip: t('queue.taskTooltip'),
    }
  }
  return {
    color: tokens.colors.accent.primary,
    icon: FiCornerDownRight,
    badge: t('queue.badgeSteer'),
    tooltip: t('queue.steerTooltip'),
  }
}

/** True when the command queue holds an entry the ACTIVE session's strip
 *  would render. PromptBar subscribes to square-round the input's top
 *  corners while the stack is fused on top of it. */
export function useHasQueuedForActiveSession(): boolean {
  const queued = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
  const activeSessionId = useChatStore(s => s.activeSessionId)
  return queued.some(cmd => !cmd.sessionId || cmd.sessionId === activeSessionId)
}

/**
 * Pop a queued command back into the composer: text goes to the draft
 * (appended on a new line when a draft is already in progress — editing
 * must never eat what the user is typing), attachment blocks return as
 * draft attachment chips. The command leaves the queue.
 */
function restoreToDraft(cmd: QueuedCommand): void {
  const chat = useChatStore.getState()
  let text: string
  const attachments: Attachment[] = []
  if (typeof cmd.value === 'string') {
    text = cmd.value
  } else {
    const texts: string[] = []
    for (const block of cmd.value) {
      if (block.type === 'text') texts.push(block.text)
      else attachments.push(block.attachment)
    }
    text = texts.join('\n')
  }
  if (text.length > 0) {
    const draft = chat.draftInput
    chat.setDraftInput(draft.trim().length > 0 ? `${draft}\n${text}` : text)
  }
  for (const att of attachments) chat.addDraftAttachment(att)
  removeFromQueue([cmd])
  window.dispatchEvent(new CustomEvent('promptbar:focus'))
}

/** Tiny ghost icon-button used for edit/reorder/remove row actions. */
function RowActionButton({
  label,
  disabled,
  hoverColor,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  hoverColor?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      justifyContent="center"
      w="18px"
      h="18px"
      borderRadius="full"
      flexShrink={0}
      cursor={disabled ? 'default' : 'pointer'}
      opacity={disabled ? 0.25 : 1}
      color={tokens.colors.text.disabled}
      _hover={disabled ? {} : { color: hoverColor ?? tokens.colors.text.primary, bg: tokens.colors.bg.whiteSubtle }}
      transition={tokens.transition.fast}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Box>
  )
}

function QueuedMessagesPreview({ placement = 'docked' }: { placement?: 'docked' | 'centered' }) {
  const queuedCommands = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )
  const paused = useSyncExternalStore(subscribeToQueuePause, isQueuePaused)
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const resume = useCallback(() => setQueuePaused(false), [])

  // The queue is a single global strip, but each entry is stamped with the
  // session it was queued under — show ONLY this session's entries. A
  // message queued in project A used to render under project B's input
  // after a switch, and "leaving the queue" looked like it landed in B's
  // chat while it actually drained into A's run. Unstamped (legacy) items
  // stay visible everywhere.
  const visibleCommands = queuedCommands.filter(
    cmd => !cmd.sessionId || cmd.sessionId === activeSessionId,
  )
  const canReorder = visibleCommands.length > 1

  if (visibleCommands.length === 0) return null

  return (
    <Box
      borderRadius="12px 12px 0 0"
      border={`1px solid ${tokens.colors.border.panel}`}
      borderBottom="none"
      bg={placement === 'centered' ? tokens.colors.bg.panel : 'rgba(17, 17, 17, 0.96)'}
      overflow="hidden"
    >
      {paused && (
        // Parked queue (Stop / budget stop / rehydrated tasks): nothing
        // runs until the user resumes here or sends a new message.
        <Flex
          align="center"
          gap={2}
          px={3}
          py="6px"
          bg="rgba(255, 149, 0, 0.07)"
          borderBottom="1px solid rgba(255, 149, 0, 0.22)"
        >
          <Box color={tokens.colors.status.warning} display="flex" flexShrink={0}>
            <FiPause size={12} />
          </Box>
          <Text fontSize="11px" color={tokens.colors.status.warning} fontWeight="600" flex={1} lineClamp={1}>
            {t('queue.paused')}
          </Text>
          <Box
            as="button"
            px={2}
            h="20px"
            borderRadius="6px"
            fontSize="10.5px"
            fontWeight="700"
            color={tokens.colors.status.warning}
            border="1px solid rgba(255, 149, 0, 0.35)"
            cursor="pointer"
            flexShrink={0}
            bg="transparent"
            _hover={{ bg: 'rgba(255, 149, 0, 0.12)' }}
            transition={tokens.transition.fast}
            onClick={resume}
          >
            {t('queue.resume')}
          </Box>
        </Flex>
      )}
      {visibleCommands.map((cmd, index) => {
        const kind = kindOf(cmd)
        const KindIcon = kind.icon
        return (
          <Flex
            key={cmd.uuid ?? `queued-${index}`}
            align="center"
            gap={2}
            px={3}
            py="7px"
            bg="rgba(255, 255, 255, 0.028)"
            _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
            transition={tokens.transition.fast}
            boxShadow={`inset 2px 0 0 ${kind.color}`}
            borderBottom={
              index < visibleCommands.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none'
            }
            title={previewText(cmd.value)}
          >
            <Box color={kind.color} display="flex" flexShrink={0}>
              <KindIcon size={13} />
            </Box>
            <Text
              fontSize="12px"
              color={tokens.colors.text.secondary}
              lineClamp={1}
              flex={1}
              fontWeight="500"
            >
              {previewText(cmd.value)}
            </Text>
            <Text
              fontSize={tokens.fontSize.xs}
              color={kind.color}
              flexShrink={0}
              fontFamily={tokens.fontFamily.mono}
              textTransform="uppercase"
              letterSpacing="0.06em"
              fontWeight="700"
              title={kind.tooltip}
            >
              {kind.badge}
            </Text>
            <RowActionButton label={t('queue.editQueued')} onClick={() => restoreToDraft(cmd)}>
              <FiEdit2 size={12} />
            </RowActionButton>
            {canReorder && cmd.uuid && (
              <>
                <RowActionButton
                  label={t('queue.moveUp')}
                  disabled={index === 0}
                  onClick={() => moveInQueue(cmd.uuid!, -1)}
                >
                  <FiChevronUp size={12} />
                </RowActionButton>
                <RowActionButton
                  label={t('queue.moveDown')}
                  disabled={index === visibleCommands.length - 1}
                  onClick={() => moveInQueue(cmd.uuid!, 1)}
                >
                  <FiChevronDown size={12} />
                </RowActionButton>
              </>
            )}
            <RowActionButton
              label={t('queue.removeQueued')}
              hoverColor={tokens.colors.accent.red}
              onClick={() => removeFromQueue([cmd])}
            >
              <FiX size={12} />
            </RowActionButton>
          </Flex>
        )
      })}
    </Box>
  )
}

export default memo(QueuedMessagesPreview)
