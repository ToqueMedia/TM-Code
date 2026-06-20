// Story scene 5 — #design WOW (270f / 9s). The preview DOMINATES the screen and
// transforms in real time from plain → premium. A small #design request chip on
// top; big caption. The most memorable moment.

import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { SaasLandingMock } from '../../components/general/SaasLandingMock'
import { STORY_CAPTIONS, STORY_DESIGN_PROMPT } from '../../data/storyVertical'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const W = { x: 40, y: 300, width: 1000, height: 1440 }
const BASE = STORY_DESIGN_PROMPT.replace(' #design', '')

export const StoryDesignScene: React.FC = () => {
  const frame = useCurrentFrame()
  const chip = interpolate(frame, [6, 18], [0, 1], CLAMP)
  const chipY = interpolate(frame, [6, 18], [20, 0], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />

      {/* #design request chip (small, top) */}
      <div style={{ position: 'absolute', top: 150, left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: chip, transform: `translateY(${chipY}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: tokens.colors.accent.primarySubtle, border: `1.5px solid ${tokens.colors.accent.primary}`, borderRadius: 9999, padding: '14px 26px', fontFamily: tokens.fontFamily.ui, fontSize: 30, color: tokens.colors.text.primary }}>
          {BASE}{' '}
          <span style={{ background: 'rgba(255,255,255,0.07)', border: `1.5px solid ${tokens.colors.accent.green}`, color: tokens.colors.accent.green, borderRadius: 8, padding: '0 12px', fontWeight: 700 }}>#design</span>
        </div>
      </div>

      {/* Preview window — dominates the screen, morphs polish 0 → 1 */}
      <div style={{ position: 'absolute', left: W.x, top: W.y }}>
        <MacWindowFrame title="TM Code" subtitle="preview" width={W.width} height={W.height}>
          <SaasLandingMock width={W.width - 2} height={W.height - TITLEBAR_HEIGHT - 2} revealFrame={-12} polishFrom={64} />
        </MacWindowFrame>
      </div>

      <Caption text={STORY_CAPTIONS.design} startFrame={70} endFrame={260} position="bottom" size={60} gradient inset={240} />
    </AbsoluteFill>
  )
}
