import { memo } from 'react'
import { Flex, IconButton } from '@chakra-ui/react'
import { FiSend, FiSquare, FiCode, FiMonitor, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface PromptActionsProps {
  viewMode: string
  isStreaming: boolean
  hasInput: boolean
  hasPreview: boolean
  onToggleEditor: () => void
  onTogglePreview: () => void
  onClosePreview: () => void
  onSend: () => void
  onStop: () => void
}

function PromptActions({
  viewMode,
  isStreaming,
  hasInput,
  hasPreview,
  onToggleEditor,
  onTogglePreview,
  onClosePreview,
  onSend,
  onStop,
}: PromptActionsProps) {
  const isPreviewActive = viewMode === 'preview'

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

        {/* Preview toggle — only visible when a preview is available */}
        {hasPreview && (
          <Flex align="center" gap={0}>
            <IconButton
              aria-label={isPreviewActive ? 'Hide preview' : 'Show preview'}
              size="sm"
              variant="ghost"
              color={isPreviewActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
              borderRadius="8px"
              onClick={onTogglePreview}
            >
              <FiMonitor size={15} />
            </IconButton>

            {/* Close preview (stop server / discard) */}
            <IconButton
              aria-label="Close preview"
              size="sm"
              variant="ghost"
              color={tokens.colors.text.disabled}
              _hover={{ bg: 'rgba(248, 81, 73, 0.1)', color: tokens.colors.accent.red }}
              borderRadius="8px"
              onClick={onClosePreview}
            >
              <FiX size={14} />
            </IconButton>
          </Flex>
        )}
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
