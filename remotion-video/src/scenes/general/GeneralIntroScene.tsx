import React from 'react'
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'
import { tokens } from '../../tokens'
import { GeneralSceneBackground, edgeFade, RISE, CLAMP } from '../../components/general/sceneKit'
import { GENERAL_BRANDING } from '../../data/mockProject'

/** Scene 1 (120f) — general-audience brand opener: glow, isologo, wordmark, tagline. */
export const GeneralIntroScene: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const logoIn = spring({ frame: frame - 5, fps, config: { damping: 13 } })
  const logoOpacity = interpolate(frame, [5, 18], [0, 1], CLAMP)
  const logoScale = interpolate(logoIn, [0, 1], [0.6, 1])

  const wordmarkOpacity = interpolate(frame, [22, 34], [0, 1], CLAMP)
  const wordmarkY = interpolate(frame, [22, 34], [18, 0], RISE)

  const tagOpacity = interpolate(frame, [38, 50], [0, 1], CLAMP)
  const tagY = interpolate(frame, [38, 50], [14, 0], RISE)

  // Slow cinematic push-in across the whole scene.
  const drift = interpolate(frame, [0, 120], [1, 1.05], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: edgeFade(frame, 120) }}>
      <GeneralSceneBackground drift />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
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
              height: 180,
              opacity: logoOpacity,
              transform: `scale(${logoScale})`,
              filter: 'drop-shadow(0 8px 32px rgba(254,16,99,0.35))',
            }}
          />
          <div
            style={{
              marginTop: 30,
              fontFamily: tokens.fontFamily.ui,
              fontSize: 88,
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
            {GENERAL_BRANDING.name}
          </div>
          <div
            style={{
              marginTop: 14,
              fontFamily: tokens.fontFamily.ui,
              fontSize: 36,
              color: tokens.colors.text.secondary,
              letterSpacing: '0.02em',
              opacity: tagOpacity,
              transform: `translateY(${tagY}px)`,
            }}
          >
            {GENERAL_BRANDING.tagline}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
