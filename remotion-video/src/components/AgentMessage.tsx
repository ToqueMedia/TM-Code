import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'

export interface AgentMessageProps {
  /** Raw text; segments wrapped in `backticks` render as inline code. */
  text: string
  /** Frame (local to the enclosing Sequence) at which the message appears and typing starts. */
  startFrame: number
  /** Typewriter speed (default 3 chars per frame). */
  charsPerFrame?: number
  /** Render the full text immediately, with no fade (for pre-existing history). */
  instant?: boolean
}

const codeStyle: React.CSSProperties = {
  fontFamily: tokens.fontFamily.mono,
  background: 'rgba(255,255,255,0.07)',
  borderRadius: 5,
  padding: '1px 8px',
  fontSize: 20,
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
 * Assistant message of TM Code terminal mode: cyan rail, ◆ TM CODE header and
 * a frame-driven typewriter body (no cursor) with inline-code support.
 */
export const AgentMessage: React.FC<AgentMessageProps> = ({
  text,
  startFrame,
  charsPerFrame = 3,
  instant = false,
}) => {
  const frame = useCurrentFrame()

  // Type over the raw string (backticks included in the count), then
  // transform the visible slice into plain/code segments.
  const typedCount = Math.floor(Math.max(0, frame - startFrame) * charsPerFrame)
  const visible = instant ? text : text.slice(0, typedCount)

  const opacity = instant
    ? 1
    : interpolate(frame, [startFrame, startFrame + 5], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })

  return (
    <div
      style={{
        borderLeft: '3px solid ' + tokens.colors.chat.assistantRail,
        paddingLeft: 18,
        margin: '10px 0',
        opacity,
      }}
    >
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            color: tokens.colors.chat.assistantMarker,
            fontSize: 18,
            fontFamily: tokens.fontFamily.mono,
          }}
        >
          ◆
        </span>
        <span
          style={{
            fontSize: 14,
            letterSpacing: '0.06em',
            color: tokens.colors.text.disabled,
            fontFamily: tokens.fontFamily.mono,
          }}
        >
          TM CODE
        </span>
      </div>
      <div
        style={{
          color: tokens.colors.text.assistant,
          fontSize: 22,
          lineHeight: 1.6,
          fontFamily: tokens.fontFamily.ui,
          whiteSpace: 'pre-wrap',
        }}
      >
        {renderInline(visible)}
      </div>
    </div>
  )
}
