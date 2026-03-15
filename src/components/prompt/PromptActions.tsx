import { memo } from 'react'
import { Flex, IconButton } from '@chakra-ui/react'
import { FiSend, FiSquare, FiCode } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface PromptActionsProps {
  viewMode: string
  isStreaming: boolean
  hasInput: boolean
  onToggleEditor: () => void
  onSend: () => void
  onStop: () => void
}

function PromptActions({
  viewMode,
  isStreaming,
  hasInput,
  onToggleEditor,
  onSend,
  onStop,
}: PromptActionsProps) {
  return (
    <Flex align="center" justify="space-between" px={3} py={2}>
      <Flex align="center" gap={1}>
        {/* Editor toggle */}
        <IconButton
          aria-label="Toggle editor"
          size="sm"
          variant="ghost"
          color={viewMode === 'editor' ? tokens.colors.accent.primary : tokens.colors.text.secondary}
          _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
          borderRadius="8px"
          onClick={onToggleEditor}
        >
          <FiCode size={15} />
        </IconButton>
      </Flex>

      {/* Send / Stop button */}
      {isStreaming ? (
        <IconButton
          aria-label="Stop generation"
          size="sm"
          bg={tokens.colors.accent.redSubtle}
          color={tokens.colors.accent.red}
          borderRadius="8px"
          _hover={{ bg: tokens.colors.accent.redMuted }}
          onClick={onStop}
        >
          <FiSquare size={14} />
        </IconButton>
      ) : (
        <IconButton
          aria-label="Send message"
          size="sm"
          bg={hasInput ? tokens.colors.accent.primary : 'transparent'}
          color={hasInput ? tokens.colors.text.inverse : tokens.colors.text.disabled}
          borderRadius="8px"
          _hover={hasInput ? { bg: tokens.colors.accent.primaryDark } : {}}
          onClick={onSend}
          disabled={!hasInput}
        >
          <FiSend size={14} />
        </IconButton>
      )}
    </Flex>
  )
}

export default memo(PromptActions)
