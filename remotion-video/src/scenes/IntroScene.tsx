import React from 'react'
import {
  AbsoluteFill,
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

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const riseEase = { ...clamp, easing: Easing.out(Easing.cubic) } as const

/** Scene 1 (90f) — brand opener: glow, isologo, wordmark, tagline. */
export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const logoIn = spring({ frame: frame - 5, fps, config: { damping: 13 } })
  const logoOpacity = interpolate(frame, [5, 18], [0, 1], clamp)
  const logoScale = interpolate(logoIn, [0, 1], [0.6, 1])

  const wordmarkOpacity = interpolate(frame, [20, 32], [0, 1], clamp)
  const wordmarkY = interpolate(frame, [20, 32], [18, 0], riseEase)

  const tagOpacity = interpolate(frame, [35, 47], [0, 1], clamp)
  const tagY = interpolate(frame, [35, 47], [14, 0], riseEase)

  // Slow cinematic push-in across the whole scene.
  const drift = interpolate(frame, [0, 90], [1, 1.045], clamp)
  const fadeOut = interpolate(frame, [78, 90], [1, 0], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <AbsoluteFill style={{ background: tokens.gradient.welcomeGlow }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: fadeOut }}>
        <div
          style={{
            transform: `scale(${drift})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <Img
            src={staticFile('assets/isologo.svg')}
            style={{
              height: 170,
              opacity: logoOpacity,
              transform: `scale(${logoScale})`,
              filter: 'drop-shadow(0 8px 32px rgba(254,16,99,0.35))',
            }}
          />
          <div
            style={{
              marginTop: 30,
              fontFamily: tokens.fontFamily.ui,
              fontSize: 84,
              fontWeight: 800,
              lineHeight: 1.1,
              backgroundImage: tokens.gradient.logoTitle,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              opacity: wordmarkOpacity,
              transform: `translateY(${wordmarkY}px)`,
            }}
          >
            {BRANDING.name}
          </div>
          <div
            style={{
              marginTop: 12,
              fontFamily: tokens.fontFamily.ui,
              fontSize: 30,
              color: tokens.colors.text.secondary,
              letterSpacing: '0.02em',
              opacity: tagOpacity,
              transform: `translateY(${tagY}px)`,
            }}
          >
            {BRANDING.tagline}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
