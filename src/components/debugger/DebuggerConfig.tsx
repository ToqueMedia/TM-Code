import {
  Box,
  VStack,
  HStack,
  Text,
  Button,
  Input
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import type { DebuggerConfigProps } from './types'

function DebuggerConfig({
  configForm,
  availableDebuggers,
  loading,
  onConfigChange,
  onStart,
  onCancel
}: DebuggerConfigProps) {
  return (
    <Box
      p={4}
      bg={tokens.colors.bg.sidebar}
      borderRadius="md"
      border="1px solid"
      borderColor={tokens.colors.border.default}
    >
      <VStack gap={3} align="stretch">
        <Text fontSize="md" fontWeight="semibold" color={tokens.colors.text.primary}>
          Debug Configuration
        </Text>

        {Object.keys(availableDebuggers).length === 0 && (
          <Text fontSize="sm" color={tokens.colors.accent.orange}>
            No debuggers available. Please install Node.js.
          </Text>
        )}

        <Input
          placeholder="Configuration name"
          value={configForm.name}
          onChange={(e) => onConfigChange({ ...configForm, name: e.target.value })}
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.default}
          color={tokens.colors.text.primary}
        />

        <Input
          placeholder="Program path (e.g., ./src/index.js)"
          value={configForm.program}
          onChange={(e) => onConfigChange({ ...configForm, program: e.target.value })}
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.default}
          color={tokens.colors.text.primary}
        />

        <Input
          placeholder="Arguments (space separated)"
          value={configForm.args}
          onChange={(e) => onConfigChange({ ...configForm, args: e.target.value })}
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.default}
          color={tokens.colors.text.primary}
        />

        <HStack justify="flex-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            color={tokens.colors.text.primary}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onStart}
            disabled={Object.keys(availableDebuggers).length === 0 || loading}
            bg={tokens.colors.accent.green}
            color={tokens.colors.text.inverse}
            _hover={{ bg: tokens.colors.accent.greenHover }}
          >
            Start
          </Button>
        </HStack>
      </VStack>
    </Box>
  )
}

export default DebuggerConfig
