import { memo, useCallback, useState } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiSend } from 'react-icons/fi'
import { usePromptLogic } from '../../hooks/usePromptLogic'
import SlashCommandMenu from './SlashCommandMenu'
import { renderHighlightedPrompt } from '../prompt/promptHighlight'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

// Shared style block for the textarea + the highlight overlay so glyph
// metrics (font, leading, padding-derived offsets) match exactly. Mismatched
// metrics make the colored overlay drift away from the actual glyphs.
const PROMPT_TEXT_STYLE: React.CSSProperties = {
  fontSize: '13.5px',
  fontFamily: tokens.fontFamily.ui,
  lineHeight: '24px',
  letterSpacing: '-0.005em',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: 0,
  tabSize: 2,
}

function PromptInput() {
  const {
    input,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    isArgMode,
    textareaRef,
    isStreaming,
    canSend,
    handleInputChange,
    handleCommandSelect,
    handleSend,
    handleKeyDown,
    handleBlur,
  } = usePromptLogic()

  // Sync textarea scroll → overlay translateY so the highlight stays under
  // the actual glyphs once content exceeds the visible 6 rows.
  const [scrollTop, setScrollTop] = useState(0)
  const handleScroll = useCallback(() => {
    if (textareaRef.current) setScrollTop(textareaRef.current.scrollTop)
  }, [textareaRef])

  return (
    <Box px={4} py={3} bg={tokens.colors.bg.app} position="relative">
      {/* Slash command autocomplete menu */}
      {showCommandMenu && (
        <SlashCommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={handleCommandSelect}
          showArgsHint={isArgMode}
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
          <Box
            flex="1"
            position="relative"
            // The textarea below draws its own text transparent so the colored
            // overlay can show through. WebkitTextFillColor cascades onto the
            // ::placeholder pseudo-element by default — un-transparent it so
            // the empty-state hint renders normally.
            css={{
              '& > textarea::placeholder': {
                color: tokens.colors.text.muted,
                WebkitTextFillColor: tokens.colors.text.muted,
                opacity: 1,
              },
              // Selection background still works on the transparent textarea
              // text, but with WebkitTextFillColor: transparent the selected
              // glyphs are invisible — restore them so users can SEE what
              // they're copying. Override via ::selection on the textarea.
              '& > textarea::selection': {
                color: tokens.colors.text.primary,
                WebkitTextFillColor: tokens.colors.text.primary,
                background: 'rgba(254, 16, 99, 0.35)',
              },
            }}
          >
            {/* Highlight overlay — rendered behind the textarea. The textarea
                draws its own text transparent (color + WebkitTextFillColor)
                and exposes only the caret so the colored spans below show
                through verbatim. caret-color keeps the cursor visible. */}
            <Box
              aria-hidden
              position="absolute"
              inset={0}
              overflow="hidden"
              pointerEvents="none"
              color={tokens.colors.text.primary}
              opacity={isStreaming ? 0.4 : 1}
              style={{
                ...PROMPT_TEXT_STYLE,
                transform: `translateY(-${scrollTop}px)`,
              }}
            >
              {renderHighlightedPrompt(input)}
              {input.endsWith('\n') ? '\u200b' : null}
            </Box>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              onScroll={handleScroll}
              placeholder={t('prompt.placeholder')}
              aria-label={t("prompt.ariaLabel")}
              disabled={isStreaming}
              rows={1}
              style={{
                ...PROMPT_TEXT_STYLE,
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'transparent',
                caretColor: tokens.colors.text.primary,
                WebkitTextFillColor: 'transparent',
                resize: 'none',
                maxHeight: `${6 * 24}px`,
                overflowY: 'auto',
                opacity: isStreaming ? 0.4 : 1,
                position: 'relative',
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
