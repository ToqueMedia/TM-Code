import { Box, HStack, Text, IconButton } from '@chakra-ui/react'
import { FiTrash2, FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { DebugConsoleProps } from './types'

function DebugConsole({
  debugConsole,
  expanded,
  onToggle,
  onClear
}: DebugConsoleProps) {
  return (
    <Box flex={1}>
      <HStack justify="space-between" mb={2}>
        <HStack cursor="pointer" onClick={onToggle}>
          <Text fontSize="sm" fontWeight="semibold" color={tokens.colors.text.primary}>
            Debug Console ({debugConsole.length})
          </Text>
          <FiChevronDown
            style={{
              transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: `transform ${tokens.transition.normal}`,
              color: tokens.colors.text.secondary
            }}
          />
        </HStack>
        <IconButton
          aria-label="Clear console"
          size="xs"
          variant="ghost"
          onClick={onClear}
        >
          <FiTrash2 />
        </IconButton>
      </HStack>
      {expanded && (
        <Box
          flex={1}
          minHeight="150px"
          maxHeight="200px"
          bg={tokens.colors.bg.dark}
          color={tokens.colors.accent.green}
          p={3}
          borderRadius="md"
          fontSize="xs"
          fontFamily="monospace"
          overflowY="auto"
          border="1px solid"
          borderColor={tokens.colors.border.default}
        >
          {debugConsole.length === 0 ? (
            <Text color={tokens.colors.text.subtle}>
              Debug console output will appear here...
            </Text>
          ) : (
            debugConsole.map((line, index) => (
              <Text key={index} mb={1}>
                {line}
              </Text>
            ))
          )}
        </Box>
      )}
    </Box>
  )
}

export default DebugConsole
