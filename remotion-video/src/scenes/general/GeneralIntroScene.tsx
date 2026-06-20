import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'
import { GeneralSceneBackground, RISE } from '../../components/general/sceneKit'
import { GENERAL_BRANDING, GENERAL_INTRO } from '../../data/mockProject'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/** Hook (90f) — logo + central message. Fades in from black at the very start;
 *  no fade-OUT (cuts straight into the first title card, dark→dark). */
export const GeneralIntroScene: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const logoIn = spring({ frame: frame - 3, fps, config: { damping: 13 } })
  const logoOpacity = interpolate(frame, [3, 14], [0, 1], CLAMP)
  const logoScale = interpolate(logoIn, [0, 1], [0.6, 1], CLAMP)

  const wordmark = { opacity: interpolate(frame, [14, 26], [0, 1], CLAMP), y: interpolate(frame, [14, 26], [16, 0], RISE) }
  const head = { opacity: interpolate(frame, [28, 42], [0, 1], CLAMP), y: interpolate(frame, [28, 42], [18, 0], RISE) }
  const sub = { opacity: interpolate(frame, [46, 60], [0, 1], CLAMP), y: interpolate(frame, [46, 60], [14, 0], RISE) }
  const drift = interpolate(frame, [0, 90], [1, 1.04], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: interpolate(frame, [0, 8], [0, 1], CLAMP) }}>
      <GeneralSceneBackground drift />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${drift})`, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '0 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, opacity: wordmark.opacity, transform: `translateY(${wordmark.y}px)` }}>
            <Img src={staticFile('assets/isologo.svg')} style={{ height: 64, opacity: logoOpacity, transform: `scale(${logoScale})`, filter: 'drop-shadow(0 8px 32px rgba(254,16,99,0.35))' }} />
            <span style={{ fontFamily: tokens.fontFamily.ui, fontSize: 48, fontWeight: 800, lineHeight: 1, backgroundImage: tokens.gradient.logoTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
              {GENERAL_BRANDING.name}
            </span>
          </div>
          <div style={{ marginTop: 30, fontFamily: tokens.fontFamily.ui, fontSize: 58, fontWeight: 800, lineHeight: 1.08, letterSpacing: '-0.02em', color: tokens.colors.text.primary, opacity: head.opacity, transform: `translateY(${head.y}px)` }}>
            {GENERAL_INTRO.headline}
            <br />
            <span style={{ backgroundImage: tokens.gradient.heroTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{GENERAL_INTRO.accent}</span>
          </div>
          <div style={{ marginTop: 20, fontFamily: tokens.fontFamily.ui, fontSize: 23, color: tokens.colors.text.secondary, opacity: sub.opacity, transform: `translateY(${sub.y}px)` }}>
            {GENERAL_INTRO.sub}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
