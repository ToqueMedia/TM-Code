import { memo } from 'react'
import { Box, Flex } from '@chakra-ui/react'
import { ShimmerStyle, SkeletonLine, SkeletonCircle } from '../ui/Skeleton'
import { tokens } from '@/theme/tokens'

interface BubbleProps {
  align: 'left' | 'right'
  lines: string[]
}

/** A single skeleton message bubble. */
function SkeletonBubble({ align, lines }: BubbleProps) {
  const isUser = align === 'right'
  return (
    <Flex
      justify={isUser ? 'flex-end' : 'flex-start'}
      px={4}
      mb={3}
    >
      <Flex
        direction="row"
        align="flex-start"
        gap={2}
        maxW="75%"
        flexDirection={isUser ? 'row-reverse' : 'row'}
      >
        <SkeletonCircle size="28px" />
        <Box
          bg={isUser ? tokens.colors.chat.userBubble : tokens.colors.chat.assistantBubble}
          borderRadius={tokens.radius.xl}
          px={3}
          py={2.5}
          display="flex"
          flexDirection="column"
          gap="8px"
          minW="140px"
        >
          {lines.map((w, i) => (
            <SkeletonLine key={i} width={w} height="10px" />
          ))}
        </Box>
      </Flex>
    </Flex>
  )
}

/**
 * Skeleton UI shown while a chat session is being restored from disk.
 * Renders 4 fake message bubbles alternating alignment.
 */
const ChatSkeleton = memo(function ChatSkeleton() {
  return (
    <Box py={4}>
      <ShimmerStyle />
      <SkeletonBubble align="right" lines={['85%', '60%']} />
      <SkeletonBubble align="left" lines={['90%', '75%', '50%']} />
      <SkeletonBubble align="right" lines={['70%']} />
      <SkeletonBubble align="left" lines={['95%', '80%', '65%', '40%']} />
    </Box>
  )
})

export default ChatSkeleton
