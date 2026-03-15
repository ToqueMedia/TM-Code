import { Box, VStack, HStack, Text } from '@chakra-ui/react'
import { FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { VariablesSectionProps } from './types'

function VariablesSection({
  variables,
  expanded,
  onToggle
}: VariablesSectionProps) {
  return (
    <Box>
      <HStack
        justify="space-between"
        mb={2}
        cursor="pointer"
        onClick={onToggle}
      >
        <Text fontSize="sm" fontWeight="semibold" color={tokens.colors.text.primary}>
          Variables ({variables.length})
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
          {variables.length === 0 ? (
            <Text fontSize="sm" color={tokens.colors.text.subtle}>
              No variables available
            </Text>
          ) : (
            variables.map((variable, index) => (
              <HStack
                key={index}
                justify="space-between"
                p={2}
                bg={tokens.colors.bg.overlay}
                borderRadius="sm"
                mb={1}
              >
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" fontWeight="semibold" color={tokens.colors.text.primary}>
                    {variable.name}
                  </Text>
                  <Text fontSize="xs" color={tokens.colors.text.secondary}>
                    {variable.type_name}
                  </Text>
                </VStack>
                <Text fontSize="sm" color={tokens.colors.text.primary}>
                  {variable.value}
                </Text>
              </HStack>
            ))
          )}
        </Box>
      )}
    </Box>
  )
}

export default VariablesSection
