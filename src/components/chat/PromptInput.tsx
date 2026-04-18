import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiSend } from 'react-icons/fi'
import { usePromptLogic } from '../../hooks/usePromptLogic'
import SlashCommandMenu from './SlashCommandMenu'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function PromptInput() {
  const {
    input,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    textareaRef,
    isStreaming,
    canSend,
    handleInputChange,
    handleCommandSelect,
    handleSend,
    handleKeyDown,
    handleBlur,
  } = usePromptLogic()

  return (
    <Box px={4} py={3} bg={tokens.colors.bg.app} position="relative">
      {/* Slash command autocomplete menu */}
      {showCommandMenu && (
        <SlashCommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={handleCommandSelect}
        />
      )}

      <Box
        borderRadius="14px"
        border="1px solid rgba(255, 255, 255, 0.08)"
        bg="rgba(255, 255, 255, 0.03)"
        overflow="hidden"
        transition="all 0.2s"
        cursor="text"
        onClick={() => textareaRef.current?.focus()}
        css={{
          '&:focus-within': {
            borderColor: 'rgba(254, 16, 99, 0.35)',
            boxShadow: '0 0 0 1px rgba(254, 16, 99, 0.1), 0 4px 20px rgba(254, 16, 99, 0.06)',
          },
        }}
      >
        <Flex align="flex-end" gap={2} px={3} py="10px">
          <Box flex="1" position="relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              placeholder="Ask TM Code to help with your code... (type / for commands)"
              aria-label={t("prompt.ariaLabel")}
              disabled={isStreaming}
              rows={1}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: tokens.colors.text.primary,
                fontSize: '13.5px',
                fontFamily: tokens.fontFamily.ui,
                resize: 'none',
                lineHeight: '24px',
                maxHeight: `${6 * 24}px`,
                overflowY: 'auto',
                opacity: isStreaming ? 0.4 : 1,
                letterSpacing: '-0.005em',
              }}
            />
          </Box>
          <Flex
            as="button"
            w="30px"
            h="30px"
            borderRadius="8px"
            bg={canSend ? tokens.gradient.accentPrimary : 'transparent'}
            align="center"
            justify="center"
            cursor={canSend ? 'pointer' : 'default'}
            transition="all 0.15s"
            flexShrink={0}
            onClick={handleSend}
            aria-disabled={!canSend}
            opacity={canSend ? 1 : 0.3}
            boxShadow={canSend ? '0 2px 10px rgba(254, 16, 99, 0.3)' : 'none'}
            _hover={canSend ? { transform: 'scale(1.05)', boxShadow: '0 4px 16px rgba(254, 16, 99, 0.4)' } : undefined}
            _active={canSend ? { transform: 'scale(0.95)' } : undefined}
          >
            <FiSend size={14} color={canSend ? '#ffffff' : tokens.colors.text.disabled} />
          </Flex>
        </Flex>

        {/* Shortcut hint */}
        <Flex
          px={3}
          py="5px"
          justify="flex-end"
          borderTop="1px solid rgba(255, 255, 255, 0.03)"
        >
          <Text fontSize="10px" color="rgba(255,255,255,0.15)" letterSpacing="0.02em">
            Enter to send, Shift + Enter for new line
          </Text>
        </Flex>
      </Box>
    </Box>
  )
}

export default memo(PromptInput)
