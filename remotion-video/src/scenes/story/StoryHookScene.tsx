// Story scene 1 — Hook (90f / 3s). Big, instant: "Tens uma ideia? Cria o
// projecto pelo Chat." + logo. Readable in 2 seconds on mobile.

import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'
import { GeneralSceneBackground, RISE } from '../../components/general/sceneKit'
import { HOOK } from '../../data/storyVertical'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const StoryHookScene: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const logoIn = spring({ frame: frame - 2, fps, config: { damping: 13 } })
  const logoScale = interpolate(logoIn, [0, 1], [0.6, 1], CLAMP)
  const logoOpacity = interpolate(frame, [2, 14], [0, 1], CLAMP)
  const q = { opacity: interpolate(frame, [14, 28], [0, 1], CLAMP), y: interpolate(frame, [14, 28], [24, 0], RISE) }
  const a = { opacity: interpolate(frame, [30, 46], [0, 1], CLAMP), y: interpolate(frame, [30, 46], [24, 0], RISE) }
  const drift = interpolate(frame, [0, 90], [1, 1.05], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: interpolate(frame, [0, 8], [0, 1], CLAMP) }}>
      <GeneralSceneBackground drift />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${drift})`, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '0 70px' }}>
          <Img src={staticFile('assets/isologo.svg')} style={{ height: 150, opacity: logoOpacity, transform: `scale(${logoScale})`, filter: 'drop-shadow(0 10px 40px rgba(254,16,99,0.4))' }} />
          <div style={{ marginTop: 60, fontFamily: tokens.fontFamily.ui, fontSize: 96, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.02em', color: tokens.colors.text.primary, opacity: q.opacity, transform: `translateY(${q.y}px)` }}>
            {HOOK.question}
          </div>
          <div style={{ marginTop: 18, fontFamily: tokens.fontFamily.ui, fontSize: 72, fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em', backgroundImage: tokens.gradient.heroTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', opacity: a.opacity, transform: `translateY(${a.y}px)` }}>
            {HOOK.answer}
          </div>
          <div style={{ marginTop: 44, fontFamily: tokens.fontFamily.mono, fontSize: 30, letterSpacing: '0.12em', textTransform: 'uppercase', color: tokens.colors.text.muted, opacity: a.opacity }}>
            {HOOK.brand}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
