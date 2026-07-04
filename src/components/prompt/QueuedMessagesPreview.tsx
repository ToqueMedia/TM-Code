/**
 * Queued Messages Preview — shows pending messages above the PromptBar.
 *
 * Each message has a cancel button to remove it from the queue.
 */

import { memo, useSyncExternalStore } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiClock, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import {
  getCommandQueueSnapshot,
  remove as removeFromQueue,
  subscribeToCommandQueue,
} from '@/services/agent/messageQueue'
import type { PromptValue } from '@/types/messageQueueTypes'

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

function QueuedMessagesPreview() {
  const queuedCommands = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  // TM Code currently only enqueues 'prompt' mode commands so every
  // queued item is user-visible. When task notifications are added,
  // re-introduce the isQueuedCommandVisible filter from Claude Code.
  const visibleCommands = queuedCommands

  if (visibleCommands.length === 0) return null

  return (
    <Box mb={2}>
      {visibleCommands.map((cmd, index) => (
        <Flex
          key={cmd.uuid ?? `queued-${index}`}
          align="center"
          gap={2}
          px={3}
          py={2}
          borderRadius="8px"
          bg="rgba(254, 16, 99, 0.055)"
          border="1px solid rgba(254, 16, 99, 0.16)"
          mb={index < visibleCommands.length - 1 ? 1 : 0}
          boxShadow="inset 2px 0 0 rgba(254, 16, 99, 0.45)"
        >
          <Box color={tokens.colors.accent.primary} display="flex" flexShrink={0}>
            <FiClock size={13} />
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
            color={tokens.colors.text.disabled}
            flexShrink={0}
            fontFamily={tokens.fontFamily.mono}
            textTransform="uppercase"
            letterSpacing="0.06em"
          >
            queued
          </Text>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="18px"
            h="18px"
            borderRadius="full"
            flexShrink={0}
            cursor="pointer"
            color={tokens.colors.text.disabled}
            _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
            transition={tokens.transition.fast}
            onClick={() => removeFromQueue([cmd])}
            aria-label="Remove queued message"
          >
            <FiX size={12} />
          </Box>
        </Flex>
      ))}
    </Box>
  )
}

export default memo(QueuedMessagesPreview)
