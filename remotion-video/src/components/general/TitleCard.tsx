// Micro chapter chip shown between phases (~0.8s). It is an OVERLAY banner — it
// does NOT paint a full-screen background, so the live, persistent Chat window
// stays visible behind it (no dark break, single continuous session). Fades in
// and out within its own sequence.

import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export interface TitleCardProps {
  text: string
}

export const TitleCard: React.FC<TitleCardProps> = ({ text }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const enter = spring({ frame, fps, config: { damping: 18 }, durationInFrames: 12 })
  // Fade IN (0→7) and OUT (17→24) so the window is fully clear before/after.
  const opacity = interpolate(frame, [0, 7], [0, 1], CLAMP) * interpolate(frame, [17, 24], [1, 0], CLAMP)
  const y = interpolate(enter, [0, 1], [16, 0], CLAMP)

  if (opacity <= 0) return null

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', opacity, transform: `translateY(${y}px)` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            background: 'rgba(13,13,15,0.86)',
            border: `1px solid ${tokens.colors.accent.primaryGlow}`,
            borderRadius: tokens.radius.pill,
            padding: '16px 30px',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 40px rgba(254,16,99,0.18)',
          }}
        >
          <Img src={staticFile('assets/isologo.svg')} style={{ height: 40, filter: 'drop-shadow(0 4px 16px rgba(254,16,99,0.45))' }} />
          <span style={{ fontFamily: tokens.fontFamily.ui, fontSize: 40, fontWeight: 700, letterSpacing: '-0.01em', color: tokens.colors.text.primary }}>
            {text}
          </span>
        </div>
        <div style={{ marginTop: 18, width: interpolate(enter, [0, 1], [0, 110], CLAMP), height: 3, borderRadius: 3, background: tokens.gradient.accentPrimary }} />
      </div>
    </AbsoluteFill>
  )
}
