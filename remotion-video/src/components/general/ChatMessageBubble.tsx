import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'

export interface ChatMessageBubbleProps {
  role: 'user' | 'assistant'
  /** Raw text; for assistant, segments wrapped in `backticks` render as inline code. */
  text: string
  /** Frame (local to the enclosing Sequence) at which the bubble appears and typing starts. */
  startFrame: number
  /** Typewriter speed (default 2.6 chars per frame). */
  charsPerFrame?: number
  /** Render the full text immediately, with no fade (for pre-existing history). */
  instant?: boolean
  /** Max bubble width in px (default 640). */
  maxWidth?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const codeStyle: React.CSSProperties = {
  fontFamily: tokens.fontFamily.mono,
  background: 'rgba(255,255,255,0.07)',
  borderRadius: 5,
  padding: '1px 8px',
  color: tokens.colors.text.primary,
}

/**
 * Splits a (possibly partial) visible slice on backticks: even segments are
 * plain text, odd segments are inline code. The backticks themselves are
 * never rendered.
 */
const renderInline = (visible: string): React.ReactNode[] =>
  visible.split('`').map((segment, i) =>
    i % 2 === 1 ? (
      <code key={i} style={codeStyle}>
        {segment}
      </code>
    ) : (
      <React.Fragment key={i}>{segment}</React.Fragment>
    ),
  )

/**
 * A single chat bubble for the general-audience promo composition.
 *
 * - role "user": left-aligned but clearly the user — pink-subtle bubble with a
 *   pink left rail, no header.
 * - role "assistant": a card bubble with a cyan ◆ "TM CODE" header and a
 *   frame-driven typewriter body that supports inline `code` segments.
 */
export const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = ({
  role,
  text,
  startFrame,
  charsPerFrame = 2.6,
  instant = false,
  maxWidth = 640,
}) => {
  const frame = useCurrentFrame()

  // Type over the raw string (backticks included in the count), then transform
  // the visible slice into plain/code segments.
  const typedCount = Math.floor(Math.max(0, frame - startFrame) * charsPerFrame)
  const visible = instant ? text : text.slice(0, typedCount)

  const opacity = instant
    ? 1
    : interpolate(frame, [startFrame, startFrame + 5], [0, 1], CLAMP)

  if (role === 'user') {
    return (
      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth,
          background: tokens.colors.accent.primarySubtle,
          borderLeft: '3px solid ' + tokens.colors.accent.primary,
          borderRadius: '0 12px 12px 0',
          padding: '14px 18px',
          color: tokens.colors.text.primary,
          fontSize: 21,
          fontFamily: tokens.fontFamily.ui,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          opacity,
        }}
      >
        {visible}
      </div>
    )
  }

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth,
        background: tokens.colors.bg.card,
        borderRadius: 12,
        padding: '14px 18px',
        opacity,
      }}
    >
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            color: tokens.colors.chat.assistantMarker,
            fontSize: 16,
            fontFamily: tokens.fontFamily.mono,
          }}
        >
          ◆
        </span>
        <span
          style={{
            fontSize: 12,
            letterSpacing: '0.08em',
            color: tokens.colors.text.disabled,
            fontFamily: tokens.fontFamily.mono,
          }}
        >
          TM Code
        </span>
      </div>
      <div
        style={{
          color: tokens.colors.text.assistant,
          fontSize: 20,
          lineHeight: 1.55,
          fontFamily: tokens.fontFamily.ui,
          whiteSpace: 'pre-wrap',
        }}
      >
        {renderInline(visible)}
      </div>
    </div>
  )
}
