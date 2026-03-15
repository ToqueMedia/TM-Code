import { Box, HStack, Text } from '@chakra-ui/react'
import { FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { CallStackSectionProps } from './types'

function CallStackSection({
  callStack,
  expanded,
  onToggle
}: CallStackSectionProps) {
  return (
    <Box>
      <HStack
        justify="space-between"
        mb={2}
        cursor="pointer"
        onClick={onToggle}
      >
        <Text fontSize="sm" fontWeight="semibold" color={tokens.colors.text.primary}>
          Call Stack ({callStack.length})
        </Text>
        <FiChevronDown
          style={{
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: `transform ${tokens.transition.normal}`,
            color: tokens.colors.text.secondary
          }}
        />
      </HStack>
      {expanded && (
        <Box
          maxHeight="120px"
          overflowY="auto"
          bg={tokens.colors.bg.sidebar}
          borderRadius="md"
          p={2}
        >
          {callStack.length === 0 ? (
            <Text fontSize="sm" color={tokens.colors.text.subtle}>
              No stack frames available
            </Text>
          ) : (
            callStack.map(frame => (
              <Box
                key={frame.id}
                p={2}
                bg={tokens.colors.bg.overlay}
                borderRadius="sm"
                mb={1}
              >
                <Text fontSize="sm" fontWeight="semibold" color={tokens.colors.text.primary}>
                  {frame.name}
                </Text>
                <Text fontSize="xs" color={tokens.colors.text.secondary}>
                  {frame.file.split('/').pop()}:{frame.line}:{frame.column}
                </Text>
              </Box>
            ))
          )}
        </Box>
      )}
    </Box>
  )
}

export default CallStackSection
