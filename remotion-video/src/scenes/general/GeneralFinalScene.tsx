// Scene 9 of the general promo (150f) — the final CTA. PART A pulls the finished
// IDE window back into darkness (camera pull-back idiom borrowed from
// FinalScene.tsx), PART B brings up the GeneralCTA card, and a closing #000
// AbsoluteFill fades the whole thing to black at the very end.
//
// Frame-driven only; colors/gradients/shadows from tokens.

import React from 'react'
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT } from '../../data/mockProject'
import { GENERAL_MESSAGES } from '../../data/generalPromoScript'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { TMCodeTerminal } from '../../components/TMCodeTerminal'
import { AgentMessage } from '../../components/AgentMessage'
import { GeneralCTA } from '../../components/general/GeneralCTA'
import { GeneralSceneBackground } from '../../components/general/sceneKit'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const PULL = { ...CLAMP, easing: Easing.bezier(0.4, 0, 0.2, 1) } as const

const W = GLAYOUT.window

export const GeneralFinalScene: React.FC = () => {
  const frame = useCurrentFrame()

  // Root: gentle fade-in only — the closing #000 owns the exit.
  const rootOpacity = interpolate(frame, [0, 8], [0, 1], CLAMP)

  // PART A — finished IDE pulls back into darkness.
  const windowScale = interpolate(frame, [0, 45], [1, 0.55], PULL)
  const windowOpacity =
    interpolate(frame, [0, 8], [0, 1], CLAMP) * interpolate(frame, [20, 45], [1, 0], PULL)

  // PART B — closing fade to pure black.
  const closingFade = interpolate(frame, [138, 150], [0, 1], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: rootOpacity }}>
      <GeneralSceneBackground />

      {/* PART A — the finished IDE pulls back into darkness */}
      {windowOpacity > 0 ? (
        <AbsoluteFill
          style={{
            opacity: windowOpacity,
            transform: `scale(${windowScale})`,
            transformOrigin: 'center center',
          }}
        >
          <div style={{ position: 'absolute', left: W.x, top: W.y }}>
            <MacWindowFrame
              title="TM Code"
              subtitle={SAAS_PROJECT.name}
              width={W.width}
              height={W.height}
            >
              <TMCodeTerminal
                width={W.width - 2}
                height={W.height - TITLEBAR_HEIGHT - 2}
                statusLabel="ready"
                statusKind="ready"
                elapsedText="1m 12s"
                bottomAnchor
              >
                <AgentMessage text={GENERAL_MESSAGES.done} startFrame={0} instant />
              </TMCodeTerminal>
            </MacWindowFrame>
          </div>
        </AbsoluteFill>
      ) : null}

      {/* PART B — the final CTA card */}
      <GeneralCTA startFrame={40} />

      {/* Closing fade to pure black */}
      <AbsoluteFill style={{ backgroundColor: '#000000', opacity: closingFade }} />
    </AbsoluteFill>
  )
}
