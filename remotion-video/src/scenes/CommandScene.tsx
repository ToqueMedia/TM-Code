import React from 'react'
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { TE2E } from '../data/agentScript'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const riseEase = { ...clamp, easing: Easing.out(Easing.cubic) } as const

const TYPE_START = 16
const TYPE_SPEED = 1.2 // chars per frame — deliberate, readable typing

/** Fade + rise entrance helper for the stacked rows. */
const enter = (frame: number, at: number): React.CSSProperties => ({
  opacity: interpolate(frame, [at, at + 10], [0, 1], clamp),
  transform: `translateY(${interpolate(frame, [at, at + 10], [14, 0], riseEase)}px)`,
})

/**
 * Scene 4b (105f) — dedicated /te2e command card.
 * The hero shot of the feature: the command being typed in a TM Code-style
 * prompt, with the real product description underneath.
 */
export const CommandScene: React.FC = () => {
  const frame = useCurrentFrame()

  const opacity =
    interpolate(frame, [0, 8], [0, 1], clamp) * interpolate(frame, [99, 105], [1, 0], clamp)
  const push = interpolate(frame, [0, 105], [1, 1.04], clamp)

  // Typewriter over the full typed string; the "/te2e" head renders brand-pink.
  const typedChars = Math.max(0, Math.floor((frame - TYPE_START) * TYPE_SPEED))
  const visible = TE2E.typed.slice(0, typedChars)
  const commandPart = visible.slice(0, TE2E.command.length)
  const argsPart = visible.slice(TE2E.command.length)
  const typingDone = typedChars >= TE2E.typed.length
  const cursorOn = !typingDone || Math.floor(frame / 16) % 2 === 0

  // The input "focuses" (pink ring) as typing starts.
  const focusRing = interpolate(frame, [TYPE_START - 4, TYPE_START + 6], [0, 1], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <AbsoluteFill style={{ background: tokens.gradient.welcomeGlow }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity }}>
        <div
          style={{
            transform: `scale(${push})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: 1280,
          }}
        >
          {/* Eyebrow */}
          <div
            style={{
              ...enter(frame, 6),
              fontFamily: tokens.fontFamily.mono,
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              color: tokens.colors.accent.primary,
            }}
          >
            TM Code · Terminal Mode
          </div>

          {/* The command input */}
          <div
            style={{
              ...enter(frame, 10),
              marginTop: 34,
              width: 1100,
              padding: '30px 38px',
              borderRadius: 18,
              background: tokens.colors.bg.input,
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: `0 0 0 ${3 * focusRing}px rgba(254,16,99,${0.22 * focusRing}), 0 24px 70px rgba(0,0,0,0.45)`,
              display: 'flex',
              alignItems: 'center',
              gap: 22,
              fontFamily: tokens.fontFamily.mono,
              fontSize: 42,
              lineHeight: 1.3,
            }}
          >
            <span style={{ color: tokens.colors.chat.userRail, fontWeight: 700 }}>❯</span>
            <span style={{ whiteSpace: 'pre', fontWeight: 600 }}>
              <span style={{ color: tokens.colors.accent.primary }}>{commandPart}</span>
              <span style={{ color: tokens.colors.text.userPrompt }}>{argsPart}</span>
              {cursorOn ? (
                <span
                  style={{
                    display: 'inline-block',
                    width: 20,
                    height: 46,
                    marginLeft: 4,
                    verticalAlign: 'text-bottom',
                    background: tokens.colors.terminal.cursor,
                  }}
                />
              ) : null}
            </span>
          </div>

          {/* Real product description */}
          <div
            style={{
              ...enter(frame, 48),
              marginTop: 38,
              maxWidth: 1080,
              textAlign: 'center',
              fontFamily: tokens.fontFamily.ui,
              fontSize: 26,
              lineHeight: 1.5,
              color: tokens.colors.text.secondary,
            }}
          >
            {TE2E.description}
          </div>

          {/* Usage hint */}
          <div
            style={{
              ...enter(frame, 62),
              marginTop: 26,
              fontFamily: tokens.fontFamily.mono,
              fontSize: 19,
              color: tokens.colors.text.muted,
            }}
          >
            {TE2E.usage}
          </div>

          {/* Example chips */}
          <div style={{ display: 'flex', gap: 14, marginTop: 20 }}>
            {TE2E.examples.map((example, i) => (
              <div
                key={example}
                style={{
                  ...enter(frame, 74 + i * 6),
                  fontFamily: tokens.fontFamily.mono,
                  fontSize: 17,
                  color: tokens.colors.text.muted,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 9999,
                  padding: '9px 18px',
                }}
              >
                {example}
              </div>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
