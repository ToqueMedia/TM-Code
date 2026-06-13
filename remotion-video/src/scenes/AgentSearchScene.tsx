import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { LAYOUT } from '../data/sceneTiming'
import { AGENT_MESSAGES, PROJECT, PROMPT_TEXT, TOOL_CALLS } from '../data/agentScript'
import { MacWindowFrame } from '../components/MacWindowFrame'
import { TMCodeTerminal } from '../components/TMCodeTerminal'
import { UserPrompt } from '../components/UserPrompt'
import { AgentMessage } from '../components/AgentMessage'
import { ThinkingDots } from '../components/ThinkingDots'
import { ToolCallRow } from '../components/ToolCallRow'
import { HighlightBox } from '../components/HighlightBox'
import { ZoomFocus } from '../components/ZoomFocus'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const W = LAYOUT.terminalWindow
const TERM_W = W.width - 2
const TERM_H = W.height - 46

/** Scene 3 (90f) — the agent thinks, investigates, first search lands. */
export const AgentSearchScene: React.FC = () => {
  const frame = useCurrentFrame()

  const working = frame >= 45
  // Subtle 4-frame fades — visual continuity with scenes 2 and 4.
  const opacity =
    interpolate(frame, [0, 4], [0, 1], clamp) * interpolate(frame, [86, 90], [1, 0], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity }}>
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1.1, x: 880, y: 560 },
          { frame: 18, scale: 1.1, x: 880, y: 560 },
          // focal y 560 keeps the status line inside the bottom edge at 1.18
          { frame: 44, scale: 1.18, x: 880, y: 560 },
          { frame: 88, scale: 1.18, x: 880, y: 560 },
        ]}
      >
        <div style={{ position: 'absolute', left: W.x, top: W.y }}>
          <MacWindowFrame title="TM Code" subtitle={PROJECT.name} width={W.width} height={W.height}>
            <TMCodeTerminal
              width={TERM_W}
              height={TERM_H}
              statusLabel={working ? 'working' : 'thinking'}
              statusKind={working ? 'working' : 'thinking'}
              tokensText="3.4k tokens"
              elapsedText="12s"
            >
              <UserPrompt text={PROMPT_TEXT} startFrame={0} instant />
              <ThinkingDots startFrame={2} endFrame={30} />
              <AgentMessage text={AGENT_MESSAGES.investigate} startFrame={24} />
              <ToolCallRow spec={TOOL_CALLS.search} startFrame={54} doneFrame={70} />
            </TMCodeTerminal>
          </MacWindowFrame>
        </div>

        {/* "7 results" summary: content origin (190,150); prompt ≈100px + dots row ≈44
            + agent message ≈70 + tool header ≈36 → summary line lands ≈ y 405. */}
        <HighlightBox x={200} y={398} width={170} height={46} startFrame={76} endFrame={86} />
      </ZoomFocus>
    </AbsoluteFill>
  )
}
