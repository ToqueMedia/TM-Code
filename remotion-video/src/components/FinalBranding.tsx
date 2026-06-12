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
import { tokens } from '../tokens'
import { BRANDING } from '../data/agentScript'

export interface FinalBrandingProps {
  /** Frame (local to the enclosing Sequence) at which the branding sequence starts. */
  startFrame: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const EASE_OUT = Easing.out(Easing.cubic)

/**
 * Final branding card: logo pop, gradient wordmark, tagline, word-by-word
 * phrase reveal, CTA pill with a slow breath, sub-line and platforms line.
 */
export const FinalBranding: React.FC<FinalBrandingProps> = ({ startFrame }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Logo: playful pop (damping 13), scale 0.7 → 1 + fade.
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
  const tagline = riseIn(startFrame + 22, 14)

  // CTA: pop at startFrame + 70 (damping 14), then a slow deterministic breath.
  const ctaPop = spring({ frame: frame - (startFrame + 70), fps, config: { damping: 14 } })
  const breath = 1 + 0.012 * Math.sin(frame / 18)
  const ctaScale = (0.6 + 0.4 * ctaPop) * breath
  const ctaOpacity = interpolate(frame, [startFrame + 70, startFrame + 76], [0, 1], CLAMP)

  const ctaSubOpacity = interpolate(frame, [startFrame + 82, startFrame + 92], [0, 1], CLAMP)
  const platformsOpacity = interpolate(frame, [startFrame + 92, startFrame + 102], [0, 1], CLAMP)

  const words = BRANDING.phrase.split(' ')

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
          height: 170,
          filter: 'drop-shadow(0 8px 32px rgba(254,16,99,0.35))',
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
        }}
      />

      <div
        style={{
          fontSize: 88,
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
        {BRANDING.name}
      </div>

      <div
        style={{
          fontSize: 30,
          color: tokens.colors.text.secondary,
          marginTop: 10,
          opacity: tagline.opacity,
          transform: `translateY(${tagline.y}px)`,
        }}
      >
        {BRANDING.tagline}
      </div>

      {/* Word-by-word reveal: word i appears at startFrame + 40 + i*4 */}
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
          const from = startFrame + 40 + i * 4
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
          borderRadius: 9999,
          boxShadow: tokens.shadow.dialogButton,
          opacity: ctaOpacity,
          transform: `scale(${ctaScale})`,
        }}
      >
        {BRANDING.cta}
      </div>

      <div
        style={{
          fontSize: 19,
          color: tokens.colors.text.muted,
          marginTop: 22,
          opacity: ctaSubOpacity,
        }}
      >
        {BRANDING.ctaSub}
      </div>

      <div
        style={{
          fontSize: 17,
          color: tokens.colors.text.disabled,
          marginTop: 14,
          opacity: platformsOpacity,
        }}
      >
        {BRANDING.platforms}
      </div>
    </div>
  )
}
