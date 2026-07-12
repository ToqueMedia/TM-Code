/**
 * Queued Messages Preview — the queue strip above the PromptBar.
 *
 * Two kinds of entries share the strip, with distinct semantics and visuals:
 *  - STEER (default, pink) — joins the RUNNING task at its next turn
 *    boundary (drained by the steering collectors mid-run).
 *  - TASK (`asTask`, purple) — waits for the current run to END, then the
 *    idle drain (queueProcessor) starts it as its OWN run, one at a time.
 *
 * Every entry can be removed; with 2+ entries they can be reordered — queue
 * order is execution order (the idle drain respects it, and the batch drain
 * never crosses a task boundary).
 */

import { memo, useSyncExternalStore } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronDown, FiChevronUp, FiCornerDownRight, FiLayers, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import {
  getCommandQueueSnapshot,
  moveInQueue,
  remove as removeFromQueue,
  subscribeToCommandQueue,
} from '@/services/agent/messageQueue'
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

/** Tiny ghost icon-button used for reorder/remove row actions. */
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

function QueuedMessagesPreview() {
  const queuedCommands = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  // TM Code currently only enqueues 'prompt' mode commands so every
  // queued item is user-visible. When task notifications are added,
  // re-introduce the isQueuedCommandVisible filter from Claude Code.
  const visibleCommands = queuedCommands
  const canReorder = visibleCommands.length > 1

  if (visibleCommands.length === 0) return null

  return (
    <Box mb={2}>
      {visibleCommands.map((cmd, index) => {
        const kind = kindOf(cmd)
        const KindIcon = kind.icon
        return (
          <Flex
            key={cmd.uuid ?? `queued-${index}`}
            align="center"
            gap={2}
            px={3}
            py={2}
            borderRadius="8px"
            bg="rgba(255, 255, 255, 0.028)"
            border="1px solid rgba(255, 255, 255, 0.07)"
            mb={index < visibleCommands.length - 1 ? 1 : 0}
            boxShadow={`inset 2px 0 0 ${kind.color}`}
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
