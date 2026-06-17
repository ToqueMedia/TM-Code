// Prompt bar mock for the general promo — a rounded input row with a
// frame-driven typewriter, a blinking block caret and a circular send button.
// Optional syntax-hint chips sit below, echoing the real product's slash /
// mention / opt-in affordances.

import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { PROMPT_HINTS } from '../../data/mockProject'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export interface PromptBarMockProps {
  text: string
  startFrame: number
  width?: number
  charsPerFrame?: number
  showHints?: boolean
}

/** Color the leading sigil of each hint to suggest syntax highlighting. */
const sigilColor = (sigil: string): string => {
  if (sigil === '/') return tokens.colors.accent.primary
  if (sigil === '@') return tokens.colors.accent.purple
  if (sigil === '#') return tokens.colors.accent.green
  return tokens.colors.text.muted
}

export const PromptBarMock: React.FC<PromptBarMockProps> = ({
  text,
  startFrame,
  width,
  charsPerFrame = 1.3,
  showHints = true,
}) => {
  const frame = useCurrentFrame()

  const typedCount = Math.floor(Math.max(0, frame - startFrame) * charsPerFrame)
  const visible = text.slice(0, typedCount)
  const typingDone = typedCount >= text.length

  const opacity = interpolate(frame, [startFrame, startFrame + 6], [0, 1], CLAMP)

  // Solid caret while typing; blink once typing is done.
  const caretVisible = !typingDone || Math.floor(frame / 16) % 2 === 0

  return (
    <div style={{ width: width ?? '100%', opacity, fontFamily: tokens.fontFamily.ui }}>
      <div
        style={{
          background: tokens.colors.bg.input,
          border: `1px solid ${tokens.colors.border.glass}`,
          borderRadius: tokens.radius.xl,
          padding: '16px 18px',
          minHeight: 64,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            flex: 1,
            fontFamily: tokens.fontFamily.ui,
            fontSize: 20,
            color: tokens.colors.text.primary,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.4,
          }}
        >
          {visible}
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 24,
              background: tokens.colors.terminal.cursor,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              opacity: caretVisible ? 1 : 0,
            }}
          />
        </span>

        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: tokens.radius.pill,
            background: tokens.gradient.accentPrimary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: tokens.colors.text.inverse,
            fontSize: 20,
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          ↑
        </div>
      </div>

      {showHints ? (
        <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
          {PROMPT_HINTS.map((hint) => {
            const sigil = hint.slice(0, 1)
            const rest = hint.slice(1)
            return (
              <span
                key={hint}
                style={{
                  fontFamily: tokens.fontFamily.mono,
                  fontSize: 14,
                  color: tokens.colors.text.muted,
                  background: tokens.colors.bg.hoverSubtle,
                  padding: '4px 10px',
                  borderRadius: tokens.radius.pill,
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ color: sigilColor(sigil) }}>{sigil}</span>
                {rest}
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
