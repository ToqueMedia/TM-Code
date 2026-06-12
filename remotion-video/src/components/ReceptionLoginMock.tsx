import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'
import { LOGIN_TEXT } from '../data/mockUsers'

export interface ReceptionLoginMockProps {
  width: number
  height: number
  /** Frame at which the submit button presses and starts loading. */
  submitFrame: number
  /** Frame at which the button flips to green "Login autorizado". */
  successFrame: number
  /** Frame at which the card crossfades into the welcome state (default successFrame + 14). */
  welcomeFrame?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// ─────────────────────────────────────────────────────────────────────────────
// Card vertical stack (px, boxSizing border-box → borders cancel out for the
// center computation):
//   38 padTop
//   58 icon
//   18 gap
//   32 title line (26px / lineHeight 32px)
//    6 gap + 20 subtitle line (15px / lineHeight 20px)
//   26 gap
//   72 email field   (label 16 + 8 + input 13+20+13+2 = 48)
//   18 gap
//   72 password field
//   26 gap
//   50 submit button (14 + 22 line + 14)
//   38 padBottom
// Card height = 474. Card is vertically centered → card top = (height − 474)/2.
// Submit top within card = 38+58+18+32+6+20+26+72+18+72+26 = 386; center = 411.
// Submit center y = (height − 474)/2 + 411 = height/2 + 174.
// ─────────────────────────────────────────────────────────────────────────────
export const getLoginLayout = (width: number, height: number) => ({
  submitButton: { x: width / 2, y: height / 2 + 174 },
})

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div
      style={{
        textTransform: 'uppercase',
        fontSize: 13,
        lineHeight: '16px',
        letterSpacing: '0.05em',
        color: tokens.colors.text.muted,
        marginBottom: 8,
        fontWeight: 600,
      }}
    >
      {label}
    </div>
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: 8,
        padding: '13px 15px',
        fontSize: 16,
        lineHeight: '20px',
        color: tokens.colors.text.primary,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      {value}
    </div>
  </div>
)

/**
 * Reception login screen of the Katondo Queue demo app. Plays a full
 * submit → loading → success → welcome sequence, all frame-driven.
 */
export const ReceptionLoginMock: React.FC<ReceptionLoginMockProps> = ({
  width,
  height,
  submitFrame,
  successFrame,
  welcomeFrame,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const wf = welcomeFrame ?? successFrame + 14

  // Card entrance: fade + 16px rise over the first 10 frames.
  const cardIn = spring({ frame, fps, config: { damping: 200 } })
  const cardOpacity = interpolate(frame, [0, 10], [0, 1], CLAMP)
  const cardRise = 16 * (1 - cardIn)

  // Submit press dip: 1 → 0.96 → 1 over 6 frames.
  const pressT = interpolate(frame, [submitFrame, submitFrame + 3, submitFrame + 6], [0, 1, 0], CLAMP)

  // Success pop (small playful overshoot).
  const successPop = spring({ frame: frame - successFrame, fps, config: { damping: 12 } })
  const isLoading = frame >= submitFrame && frame < successFrame
  const isSuccess = frame >= successFrame

  // Arithmetic mapping so the damping-12 overshoot survives (playful pop).
  let buttonScale = 1 - 0.04 * pressT
  if (isSuccess) buttonScale *= 0.92 + 0.08 * successPop

  // Welcome crossfade: form content → welcome content over 12 frames.
  const welcomeT = interpolate(frame, [wf, wf + 12], [0, 1], CLAMP)

  return (
    <div
      style={{
        width,
        height,
        background: '#0c1018',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      <div
        style={{
          width: 460,
          boxSizing: 'border-box',
          background: '#10151f',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 14,
          padding: '38px 36px',
          boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
          opacity: cardOpacity,
          transform: `translateY(${cardRise}px)`,
          position: 'relative',
        }}
      >
        {/* ── Form state (fades out during the welcome crossfade) ── */}
        <div style={{ opacity: 1 - welcomeT }}>
          {/* Icon: 58px rounded square + blue monitor */}
          <div
            style={{
              width: 58,
              height: 58,
              borderRadius: 14,
              background: tokens.colors.accent.blueSubtle,
              margin: '0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width={30} height={30} viewBox="0 0 28 28" fill="none">
              <rect
                x={3.5}
                y={5}
                width={21}
                height={13.5}
                rx={2.5}
                stroke={tokens.colors.accent.blue}
                strokeWidth={2.5}
              />
              <path
                d="M14 18.5 L14 22 M9 23 L19 23"
                stroke={tokens.colors.accent.blue}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            </svg>
          </div>

          <div
            style={{
              fontSize: 26,
              lineHeight: '32px',
              fontWeight: 700,
              color: tokens.colors.text.primary,
              textAlign: 'center',
              marginTop: 18,
            }}
          >
            {LOGIN_TEXT.title}
          </div>
          <div
            style={{
              fontSize: 15,
              lineHeight: '20px',
              color: tokens.colors.text.secondary,
              textAlign: 'center',
              marginTop: 6,
            }}
          >
            {LOGIN_TEXT.subtitle}
          </div>

          <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Field label={LOGIN_TEXT.emailLabel} value={LOGIN_TEXT.email} />
            <Field label={LOGIN_TEXT.passwordLabel} value={LOGIN_TEXT.passwordDots} />
          </div>

          {/* Submit button (50px tall: 14 + 22 + 14) */}
          <div
            style={{
              marginTop: 26,
              width: '100%',
              background: isSuccess ? tokens.colors.accent.green : tokens.colors.accent.blue,
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 17,
              lineHeight: '22px',
              borderRadius: 8,
              padding: '14px 0',
              textAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              transform: `scale(${buttonScale})`,
            }}
          >
            {isLoading ? (
              <>
                <span
                  style={{
                    width: 16,
                    height: 16,
                    border: '2px solid rgba(255,255,255,0.35)',
                    borderTopColor: '#ffffff',
                    borderRadius: 9999,
                    transform: `rotate(${frame * 24}deg)`,
                    flexShrink: 0,
                  }}
                />
                <span>A entrar…</span>
              </>
            ) : isSuccess ? (
              <span>{`✓ ${LOGIN_TEXT.authorized}`}</span>
            ) : (
              <span>{LOGIN_TEXT.submit}</span>
            )}
          </div>
        </div>

        {/* ── Welcome state (fades in over the form) ── */}
        {welcomeT > 0 ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: welcomeT,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 9999,
                background: tokens.colors.accent.green,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                fontSize: 32,
                fontWeight: 700,
              }}
            >
              ✓
            </div>
            <div
              style={{
                fontSize: 25,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                marginTop: 20,
              }}
            >
              {LOGIN_TEXT.welcome}
            </div>
            <div
              style={{
                fontSize: 16,
                color: tokens.colors.text.secondary,
                marginTop: 8,
              }}
            >
              Estação Balcão 2 · Triagem
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
