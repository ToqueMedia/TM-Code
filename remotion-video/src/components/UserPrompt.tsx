import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'

export interface UserPromptProps {
  text: string
  /** Frame (local to the enclosing Sequence) at which the row appears and typing starts. */
  startFrame: number
  /** Typewriter speed (default 2.2 chars per frame). */
  charsPerFrame?: number
  /** Render the full text immediately, with no fade and no cursor (for pre-existing history). */
  instant?: boolean
}

/**
 * User message row of TM Code terminal mode: purple rail, ❯ glyph and a
 * frame-driven typewriter with a blinking block cursor.
 */
export const UserPrompt: React.FC<UserPromptProps> = ({
  text,
  startFrame,
  charsPerFrame = 2.2,
  instant = false,
}) => {
  const frame = useCurrentFrame()

  const typedCount = Math.floor(Math.max(0, frame - startFrame) * charsPerFrame)
  const visible = instant ? text : text.slice(0, typedCount)
  const typingDone = instant || typedCount >= text.length

  const opacity = instant
    ? 1
    : interpolate(frame, [startFrame, startFrame + 5], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })

  // While typing: cursor always on. After typing: blink. Instant: no cursor.
  const cursorVisible = !instant && (!typingDone || Math.floor(frame / 16) % 2 === 0)

  return (
    <div
      style={{
        borderLeft: '3px solid ' + tokens.colors.chat.userRail,
        background: tokens.colors.bg.userBubble,
        borderRadius: '0 6px 6px 0',
        padding: '14px 18px',
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
        opacity,
      }}
    >
      <span
        style={{
          color: tokens.colors.chat.userRail,
          fontWeight: 700,
          fontSize: 24,
          fontFamily: tokens.fontFamily.mono,
          lineHeight: 1.55,
        }}
      >
        ❯
      </span>
      <span
        style={{
          color: tokens.colors.text.userPrompt,
          fontSize: 23,
          fontWeight: 600,
          fontFamily: tokens.fontFamily.mono,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
        }}
      >
        {visible}
        {!instant ? (
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 26,
              background: tokens.colors.terminal.cursor,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              opacity: cursorVisible ? 1 : 0,
            }}
          />
        ) : null}
      </span>
    </div>
  )
}
