// Scene 2 of the general promo — introduces TM Code's two entry points (Chat /
// Terminal) as the hero. The two mode cards stagger in, the Chat card lifts on
// cue, and a top caption frames the choice. Frame-driven only.

import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground, edgeFade } from '../../components/general/sceneKit'
import { ModeCardsMock } from '../../components/general/ModeCardsMock'
import { CAPTIONS } from '../../data/generalPromoScript'

export const GeneralModesScene: React.FC = () => {
  const frame = useCurrentFrame()

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: edgeFade(frame, 180) }}>
      <GeneralSceneBackground />
      <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ModeCardsMock startFrame={12} hoverChatFrame={95} />
      </AbsoluteFill>
      <Caption text={CAPTIONS.modes} position="top" startFrame={18} endFrame={160} size={42} />
    </AbsoluteFill>
  )
}
