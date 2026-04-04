/**
 * Queued Messages Preview — shows pending messages above the PromptBar.
 *
 * Inspired by Claude Code's PromptInputQueuedCommands.tsx:
 * - Renders queued commands as a lightweight preview (not in chat history)
 * - Disappears when commands are processed
 * - Uses useSyncExternalStore via useCommandQueue for reactivity
 */

import { memo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useCommandQueue } from '@/services/agent/messageQueue'

function QueuedMessagesPreview() {
  const queuedCommands = useCommandQueue()

  if (queuedCommands.length === 0) return null

  return (
    <Box mb={2}>
      {queuedCommands.map((cmd, index) => (
        <Flex
          key={cmd.id}
          align="center"
          gap={2}
          px={3}
          py={1.5}
          borderRadius="8px"
          bg="rgba(254, 16, 99, 0.06)"
          border={`1px solid rgba(254, 16, 99, 0.15)`}
          mb={index < queuedCommands.length - 1 ? 1 : 0}
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
        </Flex>
      ))}
    </Box>
  )
}

export default memo(QueuedMessagesPreview)
