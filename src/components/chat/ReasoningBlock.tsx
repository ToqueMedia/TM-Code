import { memo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronRight, FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface ReasoningBlockProps {
  content: string
  isVisible: boolean
  isStreaming: boolean
  onToggle: () => void
}

function ReasoningBlock({ content, isVisible, isStreaming, onToggle }: ReasoningBlockProps) {
  if (!content) return null

  return (
    <Box mb={3}>
      <Flex
        align="center"
        gap={1.5}
        cursor="pointer"
        onClick={onToggle}
        py="5px"
        px="8px"
        borderRadius="6px"
        _hover={{ bg: 'rgba(255, 255, 255, 0.04)' }}
        transition="background 0.12s"
        userSelect="none"
      >
        <Box color={tokens.colors.text.disabled} transition="transform 0.15s" flexShrink={0}>
          {isVisible ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        </Box>
        <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500" letterSpacing="0.01em">
          {isStreaming ? 'Thinking...' : 'Thought process'}
        </Text>
        {isStreaming && (
          <Flex gap="3px" align="center" ml={1}>
            {[0, 1, 2].map(i => (
              <Box
                key={i}
                w="3px"
                h="3px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                animation={`reasonDot 1.2s ease-in-out ${i * 0.15}s infinite`}
                css={{
                  '@keyframes reasonDot': {
                    '0%, 80%, 100%': { opacity: 0.2, transform: 'scale(0.8)' },
                    '40%': { opacity: 1, transform: 'scale(1)' },
                  },
                }}
              />
            ))}
          </Flex>
        )}
      </Flex>

      {isVisible && (
        <Box
          mt="4px"
          ml="6px"
          pl={3}
          borderLeft={`2px solid rgba(254, 16, 99, 0.15)`}
          maxH="320px"
          overflowY="auto"
          py="10px"
          px="12px"
          css={{
            '&::-webkit-scrollbar': { width: '3px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
          }}
        >
          <Text
            fontSize="12px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.ui}
            lineHeight="1.7"
            whiteSpace="pre-wrap"
            fontStyle="italic"
            letterSpacing="-0.005em"
          >
            {content}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default memo(ReasoningBlock)
