import { HStack, Text, IconButton } from '@chakra-ui/react'
import { FiTool, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface DebuggerHeaderProps {
  onClose: () => void
}

function DebuggerHeader({ onClose }: DebuggerHeaderProps) {
  return (
    <HStack
      justify="space-between"
      pb={2}
      borderBottom="1px solid"
      borderColor={tokens.colors.border.default}
    >
      <HStack>
        <FiTool />
        <Text fontSize="lg" fontWeight="bold">
          Debugger
        </Text>
      </HStack>
      <IconButton
        aria-label="Close debugger"
        size="sm"
        variant="ghost"
        onClick={onClose}
      >
        <FiX />
      </IconButton>
    </HStack>
  )
}

export default DebuggerHeader
