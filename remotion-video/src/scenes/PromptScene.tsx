import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { LAYOUT } from '../data/sceneTiming'
import { PROJECT, PROMPT_TEXT } from '../data/agentScript'
import { MacWindowFrame } from '../components/MacWindowFrame'
import { TMCodeTerminal } from '../components/TMCodeTerminal'
import { TerminalGreeting } from '../components/TerminalGreeting'
import { UserPrompt } from '../components/UserPrompt'
import { ZoomFocus } from '../components/ZoomFocus'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const W = LAYOUT.terminalWindow
// MacWindowFrame body = height − titlebar(44) − borders(2)
const TERM_W = W.width - 2
const TERM_H = W.height - 46

/** Scene 2 (120f) — TM Code opens; greeting; the user types the problem. */
export const PromptScene: React.FC = () => {
  const frame = useCurrentFrame()

  const thinking = frame >= 105
  const opacity =
    interpolate(frame, [0, 6], [0, 1], clamp) * interpolate(frame, [114, 120], [1, 0], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity }}>
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1, x: 960, y: 540 },
          { frame: 45, scale: 1, x: 960, y: 540 },
          // push toward the prompt block while it types (it sits ~y 400-510)
          { frame: 70, scale: 1.28, x: 800, y: 470 },
          { frame: 106, scale: 1.28, x: 800, y: 470 },
          { frame: 118, scale: 1.1, x: 880, y: 560 },
        ]}
      >
        <div style={{ position: 'absolute', left: W.x, top: W.y }}>
          <MacWindowFrame
            title="TM Code"
            subtitle={PROJECT.name}
            width={W.width}
            height={W.height}
            entranceFrame={0}
          >
            <TMCodeTerminal
              width={TERM_W}
              height={TERM_H}
              statusLabel={thinking ? 'thinking' : 'ready'}
              statusKind={thinking ? 'thinking' : 'ready'}
              tokensText="1.2k tokens"
            >
              <TerminalGreeting startFrame={8} />
              <UserPrompt text={PROMPT_TEXT} startFrame={34} charsPerFrame={2.2} />
            </TMCodeTerminal>
          </MacWindowFrame>
        </div>
      </ZoomFocus>
    </AbsoluteFill>
  )
}
