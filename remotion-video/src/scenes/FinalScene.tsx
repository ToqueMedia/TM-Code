import React from 'react'
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { LAYOUT } from '../data/sceneTiming'
import { AGENT_MESSAGES, PROJECT, WORKED_FOR_TEXT } from '../data/agentScript'
import { MacWindowFrame } from '../components/MacWindowFrame'
import { TMCodeTerminal } from '../components/TMCodeTerminal'
import { AgentMessage } from '../components/AgentMessage'
import { FinalBranding } from '../components/FinalBranding'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const pullEase = { ...clamp, easing: Easing.bezier(0.4, 0, 0.2, 1) } as const

const W = LAYOUT.terminalWindow

/** Scene 7 (300f) — camera pull-back from the finished IDE into the branding CTA. */
export const FinalScene: React.FC = () => {
  const frame = useCurrentFrame()

  const windowScale = interpolate(frame, [0, 55], [1, 0.55], pullEase)
  // Fade in 0-8 (scene 6 dips to black before us) then pull back into darkness.
  const windowOpacity =
    interpolate(frame, [0, 8], [0, 1], clamp) * interpolate(frame, [20, 55], [1, 0], pullEase)
  const glowOpacity = interpolate(frame, [30, 70], [0, 1], clamp)
  // Scene is 255 frames since the /te2e command scene was added.
  const closingFade = interpolate(frame, [243, 255], [0, 1], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <AbsoluteFill style={{ background: tokens.gradient.welcomeGlow, opacity: glowOpacity }} />

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
            <MacWindowFrame title="TM Code" subtitle={PROJECT.name} width={W.width} height={W.height}>
              <TMCodeTerminal
                width={W.width - 2}
                height={W.height - 46}
                statusLabel="ready"
                statusKind="ready"
                elapsedText="1m 32s"
                bottomAnchor
              >
                <AgentMessage text={AGENT_MESSAGES.done} startFrame={0} instant />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 9999,
                      background: tokens.colors.text.disabled,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: tokens.fontFamily.mono,
                      fontSize: 17,
                      color: tokens.colors.text.disabled,
                    }}
                  >
                    {WORKED_FOR_TEXT}
                  </span>
                </div>
              </TMCodeTerminal>
            </MacWindowFrame>
          </div>
        </AbsoluteFill>
      ) : null}

      {/* PART B — branding */}
      <FinalBranding startFrame={58} />

      {/* Closing fade to black */}
      <AbsoluteFill style={{ backgroundColor: '#000000', opacity: closingFade }} />
    </AbsoluteFill>
  )
}
