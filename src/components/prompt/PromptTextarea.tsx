import React, { memo, useCallback, useState } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { renderHighlightedPrompt } from './promptHighlight'

interface PromptTextareaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onBlur?: () => void
  onPaste?: (e: React.ClipboardEvent) => void
  disabled: boolean
  /** When true, shows a queue-oriented placeholder */
  isAgentBusy?: boolean
}

// Shared text styles used by BOTH the textarea and the overlay so glyph
// metrics line up exactly (any drift between the two ruins the highlight).
const TEXT_STYLE: React.CSSProperties = {
  fontSize: tokens.fontSize.lg,
  fontFamily: tokens.fontFamily.ui,
  lineHeight: '24px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: 0,
  letterSpacing: 'normal',
  tabSize: 2,
}

function PromptTextarea({ textareaRef, value, onChange, onKeyDown, onBlur, onPaste, disabled, isAgentBusy }: PromptTextareaProps) {
  // Mirror the textarea's scrollTop onto the overlay so multi-line content
  // (>6 visible rows, when the textarea starts scrolling internally) keeps
  // the colored highlight aligned with the real glyphs underneath.
  const [scrollTop, setScrollTop] = useState(0)
  const handleScroll = useCallback(() => {
    if (textareaRef.current) setScrollTop(textareaRef.current.scrollTop)
  }, [textareaRef])

  return (
    <Box px={4} pt={3} pb={1}>
      <Box
        position="relative"
        // CRITICAL: clipping must live on the parent (not the overlay) so the
        // transformed overlay can't leak above/below the textarea's visible
        // bounds when the user scrolls inside the textarea. Earlier the
        // overlay had its own overflow:hidden, which clipped the overlay's
        // CONTENT to its first H pixels — so a scrolled textarea would show
        // the right glyphs but the highlight overlay was stuck on the first
        // page (and the transformed-up portion leaked above the box). Moving
        // the clip here makes the parent the viewport, the overlay can render
        // the full highlighted content, and translateY scrolls correctly.
        overflow="hidden"
        // The textarea has WebkitTextFillColor: transparent so the highlight
        // overlay below can show through the glyphs. That property cascades
        // into ::placeholder, hiding the empty-state hint — restore visible
        // placeholder color here.
        css={{
          '& > textarea::placeholder': {
            color: tokens.colors.text.muted,
            WebkitTextFillColor: tokens.colors.text.muted,
            opacity: 1,
          },
          // With the textarea's text rendered transparent the SELECTED glyphs
          // also disappear under the selection background. Restore visibility
          // so users can see exactly what they are copying / cutting.
          '& > textarea::selection': {
            color: tokens.colors.text.primary,
            WebkitTextFillColor: tokens.colors.text.primary,
            background: 'rgba(254, 16, 99, 0.35)',
          },
        }}
      >
        {/* Overlay — renders the FULL highlighted value (no own clipping; the
            parent box clips). Sits BEHIND the textarea visually (z-index 0)
            but above the page background. The textarea on top renders its
            text transparent so only the colored spans below show through.
            caret-color keeps the cursor visible; selection still works
            because the textarea owns input. */}
        <Box
          aria-hidden
          position="absolute"
          inset={0}
          pointerEvents="none"
          color={tokens.colors.text.primary}
          opacity={disabled ? 0.5 : 1}
          style={{
            ...TEXT_STYLE,
            transform: `translateY(-${scrollTop}px)`,
          }}
        >
          {renderHighlightedPrompt(value)}
          {/* Trailing space so a value ending in newline reserves a final
              line — keeps the overlay height matching the textarea's. */}
          {value.endsWith('\n') ? '\u200b' : null}
        </Box>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onPaste={onPaste}
          onScroll={handleScroll}
          placeholder={isAgentBusy ? t('prompt.placeholderBusy') : t('prompt.placeholder')}
          aria-label={t('prompt.ariaLabel')}
          disabled={disabled}
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          style={{
            ...TEXT_STYLE,
            width: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'transparent',
            caretColor: tokens.colors.text.primary,
            resize: 'none',
            maxHeight: `${6 * 24}px`,
            overflowY: 'auto',
            opacity: disabled ? 0.5 : 1,
            position: 'relative',
            // Webkit text-fill keeps text transparent even when browser tries
            // to colorize via autofill. Belt-and-braces with `color` above.
            WebkitTextFillColor: 'transparent',
          }}
        />
      </Box>
    </Box>
  )
}

export default memo(PromptTextarea)
