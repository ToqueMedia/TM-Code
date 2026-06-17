import React from 'react'
import {
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'
import { tokens } from '../../tokens'
import { GENERAL_BRANDING } from '../../data/mockProject'

export interface GeneralCTAProps {
  /** Frame (local to the enclosing Sequence) at which the CTA sequence starts. */
  startFrame: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const EASE_OUT = Easing.out(Easing.cubic)

/**
 * Final CTA card for the general promo: isologo pop, gradient wordmark,
 * word-by-word headline reveal, breathing download pill, sub-line and URL pill.
 */
export const GeneralCTA: React.FC<GeneralCTAProps> = ({ startFrame }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Isologo: playful pop (damping 13), scale 0.7 → 1 + fade.
  // Arithmetic mapping (not interpolate) so the spring overshoot survives.
  const logoPop = spring({ frame: frame - startFrame, fps, config: { damping: 13 } })
  const logoScale = 0.7 + 0.3 * logoPop
  const logoOpacity = interpolate(frame, [startFrame, startFrame + 8], [0, 1], CLAMP)

  // Fade + rise helper for the staggered text blocks.
  const riseIn = (from: number, distance = 18) => ({
    opacity: interpolate(frame, [from, from + 12], [0, 1], CLAMP),
    y: interpolate(frame, [from, from + 12], [distance, 0], { ...CLAMP, easing: EASE_OUT }),
  })

  const wordmark = riseIn(startFrame + 12)

  // CTA pill: pop at startFrame + 64 (damping 14), then a slow deterministic breath.
  const ctaPop = spring({ frame: frame - (startFrame + 64), fps, config: { damping: 14 } })
  const breath = 1 + 0.012 * Math.sin(frame / 18)
  const ctaScale = (0.6 + 0.4 * ctaPop) * breath
  const ctaOpacity = interpolate(frame, [startFrame + 64, startFrame + 70], [0, 1], CLAMP)

  const sub = riseIn(startFrame + 78, 12)

  const urlOpacity = interpolate(frame, [startFrame + 88, startFrame + 98], [0, 1], CLAMP)
  const urlY = interpolate(frame, [startFrame + 88, startFrame + 98], [12, 0], {
    ...CLAMP,
    easing: EASE_OUT,
  })

  const words = GENERAL_BRANDING.headline.split(' ')

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      <Img
        src={staticFile('assets/isologo.svg')}
        style={{
          height: 160,
          filter: `drop-shadow(${tokens.shadow.logoGlow})`,
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
        }}
      />

      <div
        style={{
          fontSize: 84,
          fontWeight: 800,
          marginTop: 28,
          backgroundImage: tokens.gradient.logoTitle,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          opacity: wordmark.opacity,
          transform: `translateY(${wordmark.y}px)`,
          lineHeight: 1.1,
        }}
      >
        {GENERAL_BRANDING.name}
      </div>

      {/* Word-by-word reveal: word i appears at startFrame + 34 + i*4 */}
      <div
        style={{
          display: 'flex',
          gap: 11,
          marginTop: 40,
          fontSize: 36,
          fontWeight: 600,
          color: tokens.colors.text.primary,
        }}
      >
        {words.map((word, i) => {
          const from = startFrame + 34 + i * 4
          const opacity = interpolate(frame, [from, from + 8], [0, 1], CLAMP)
          const y = interpolate(frame, [from, from + 8], [14, 0], { ...CLAMP, easing: EASE_OUT })
          return (
            <span key={`${word}-${i}`} style={{ opacity, transform: `translateY(${y}px)` }}>
              {word}
            </span>
          )
        })}
      </div>

      <div
        style={{
          marginTop: 44,
          background: tokens.gradient.accentPrimary,
          color: '#ffffff',
          fontSize: 24,
          fontWeight: 700,
          padding: '18px 46px',
          borderRadius: tokens.radius.pill,
          boxShadow: tokens.shadow.dialogButton,
          opacity: ctaOpacity,
          transform: `scale(${ctaScale})`,
        }}
      >
        {GENERAL_BRANDING.cta}
      </div>

      <div
        style={{
          fontSize: 19,
          color: tokens.colors.text.muted,
          marginTop: 22,
          opacity: sub.opacity,
          transform: `translateY(${sub.y}px)`,
        }}
      >
        {GENERAL_BRANDING.sub}
      </div>

      <div
        style={{
          marginTop: 18,
          padding: '8px 20px',
          fontSize: 18,
          fontFamily: tokens.fontFamily.mono,
          color: tokens.colors.accent.primary,
          border: `1px solid ${tokens.colors.border.glass}`,
          borderRadius: tokens.radius.pill,
          opacity: urlOpacity,
          transform: `translateY(${urlY}px)`,
        }}
      >
        {GENERAL_BRANDING.url}
      </div>
    </div>
  )
}
