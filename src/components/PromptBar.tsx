import { memo } from 'react'
import { Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import PromptTextarea from './prompt/PromptTextarea'
import PromptActions from './prompt/PromptActions'
import { usePromptBar } from './prompt/usePromptBar'

function PromptBar() {
  const {
    input,
    setInput,
    textareaRef,
    isStreaming,
    isDisabled,
    viewMode,
    hasPreview,
    handleSend,
    handleStop,
    handleKeyDown,
    toggleEditor,
    togglePreview,
    closePreview,
  } = usePromptBar()

  return (
    <Box
      px={4}
      py={3}
      bg={tokens.colors.bg.mainLayout}
      flexShrink={0}
    >
      <Box maxW="800px" mx="auto">
        {/* Main input container */}
        <Box
          bg={tokens.colors.bg.panel}
          borderRadius="14px"
          border={`1px solid ${tokens.colors.border.panel}`}
          overflow="hidden"
          transition={`border-color ${tokens.transition.normal}, box-shadow ${tokens.transition.normal}`}
          _focusWithin={{
            borderColor: tokens.colors.accent.primary,
          }}
        >
          <PromptTextarea
            textareaRef={textareaRef}
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
          />

          <PromptActions
            viewMode={viewMode}
            isStreaming={isStreaming}
            hasInput={!!input.trim() && !isDisabled}
            hasPreview={hasPreview}
            onToggleEditor={toggleEditor}
            onTogglePreview={togglePreview}
            onClosePreview={closePreview}
            onSend={handleSend}
            onStop={handleStop}
          />
        </Box>

        {/* Hint text */}
        <Text
          fontSize={tokens.fontSize.xs}
          color={tokens.colors.text.disabled}
          textAlign="center"
          mt={1.5}
        >
          {isStreaming ? 'Agent is working...' : isDisabled ? 'Awaiting permission...' : 'Cmd+Enter to send'}
        </Text>
      </Box>
    </Box>
  )
}

export default memo(PromptBar)
