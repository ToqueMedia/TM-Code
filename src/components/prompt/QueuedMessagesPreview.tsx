/**
 * Queued Messages Preview — shows pending messages above the PromptBar.
 *
 * Each message has a cancel button to remove it from the queue.
 */

import { memo, useSyncExternalStore } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import {
  getCommandQueueSnapshot,
  remove as removeFromQueue,
  subscribeToCommandQueue,
} from '@/services/agent/messageQueue'

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
          py={1.5}
          borderRadius="8px"
          bg="rgba(254, 16, 99, 0.06)"
          border={`1px solid rgba(254, 16, 99, 0.15)`}
          mb={index < visibleCommands.length - 1 ? 1 : 0}
        >
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            opacity={0.6}
            flexShrink={0}
          />
          <Text
            fontSize={tokens.fontSize.sm}
            color={tokens.colors.text.secondary}
            lineClamp={1}
            flex={1}
          >
            {cmd.value}
          </Text>
          <Text
            fontSize={tokens.fontSize.xs}
            color={tokens.colors.text.disabled}
            flexShrink={0}
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
          >
            <FiX size={12} />
          </Box>
        </Flex>
      ))}
    </Box>
  )
}

export default memo(QueuedMessagesPreview)
