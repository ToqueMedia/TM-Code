import React, { memo, useCallback, useLayoutEffect, useRef } from 'react'
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
  // the coloured highlight aligned with the real glyphs underneath.
  //
  // Using a ref + imperative DOM write (instead of useState) means the
  // overlay does NOT re-render on every scroll tick — at 60fps that's 60
  // re-renders per second of an overlay containing the entire prompt + its
  // highlight spans. The transform is the only thing that needs to change
  // per scroll, and it's a CSS property React doesn't need to mediate.
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const handleScroll = useCallback(() => {
    const ta = textareaRef.current
    const ov = overlayRef.current
    if (ta && ov) {
      ov.style.transform = `translateY(-${ta.scrollTop}px)`
    }
  }, [textareaRef])

  // After every value change, re-sync the transform: typing past the visible
  // window auto-scrolls the textarea (browser keeps the caret in view) but
  // doesn't always fire a scroll event in time, and value-driven re-renders
  // wipe inline styles set by handleScroll. useLayoutEffect runs synchronously
  // after DOM commit so the user never sees a frame with the transform stale.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    const ov = overlayRef.current
    if (ta && ov) {
      ov.style.transform = `translateY(-${ta.scrollTop}px)`
    }
  }, [value, textareaRef])

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
          // Hide the textarea's native scrollbar so its content width stays
          // equal to the overlay's. Without this, once content exceeds 6 rows
          // a ~15px gutter appears on the textarea (overflow-y: auto) and
          // shrinks its layout width — but the overlay (position:absolute;
          // inset:0) keeps full width. Same text then wraps at different
          // columns in textarea vs overlay → caret and visible glyphs drift
          // apart → the user sees a "ghost gap" before the cursor and feels
          // like backspace deletes "from a distance" (the caret was at the
          // textarea's column N, but the overlay rendered the run ending at
          // column M). Scrolling still works via wheel / touchpad / arrows.
          '& > textarea::-webkit-scrollbar': {
            width: 0,
            height: 0,
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
          ref={overlayRef}
          aria-hidden
          position="absolute"
          inset={0}
          pointerEvents="none"
          color={tokens.colors.text.primary}
          opacity={disabled ? 0.5 : 1}
          style={TEXT_STYLE}
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
