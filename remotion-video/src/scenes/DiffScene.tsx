import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { LAYOUT } from '../data/sceneTiming'
import { AGENT_MESSAGES, PROJECT, TOOL_CALLS } from '../data/agentScript'
import { usersRouteDiff, USERS_ROUTE_FOCUS } from '../data/diffData'
import { MacWindowFrame } from '../components/MacWindowFrame'
import { TMCodeTerminal } from '../components/TMCodeTerminal'
import { AgentMessage } from '../components/AgentMessage'
import { ToolCallRow } from '../components/ToolCallRow'
import { StructuredDiff } from '../components/StructuredDiff'
import { ZoomFocus } from '../components/ZoomFocus'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const W = LAYOUT.terminalWindow
const TERM_W = W.width - 2
const TERM_H = W.height - 46

/** Scene 4 (210f) — read cascade, then the force-logout diff with zooms. */
export const DiffScene: React.FC = () => {
  const frame = useCurrentFrame()

  const opacity =
    interpolate(frame, [0, 4], [0, 1], clamp) * interpolate(frame, [204, 210], [1, 0], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity }}>
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1.06, x: 960, y: 520 },
          { frame: 40, scale: 1.06, x: 960, y: 520 },
          { frame: 62, scale: 1, x: 960, y: 540 },
          { frame: 96, scale: 1, x: 960, y: 540 },
          // dive into the diff as it reveals (bottom-anchored: diff ≈ y 420-920)
          { frame: 128, scale: 1.3, x: 760, y: 660 },
          { frame: 158, scale: 1.3, x: 800, y: 665 },
          { frame: 188, scale: 1.06, x: 960, y: 540 },
          { frame: 209, scale: 1.06, x: 960, y: 540 },
        ]}
      >
        <div style={{ position: 'absolute', left: W.x, top: W.y }}>
          <MacWindowFrame title="TM Code" subtitle={PROJECT.name} width={W.width} height={W.height}>
            <TMCodeTerminal
              width={TERM_W}
              height={TERM_H}
              statusLabel="working"
              statusKind="working"
              tokensText="11.8k tokens"
              elapsedText="41s"
              bottomAnchor
            >
              <AgentMessage text={AGENT_MESSAGES.investigate} startFrame={0} instant />
              <ToolCallRow spec={TOOL_CALLS.readUsersRoute} startFrame={0} doneFrame={14} />
              <ToolCallRow spec={TOOL_CALLS.readApiUsers} startFrame={10} doneFrame={26} />
              <ToolCallRow spec={TOOL_CALLS.readUserManagement} startFrame={20} doneFrame={36} />
              <AgentMessage text={AGENT_MESSAGES.found} startFrame={44} />
              <AgentMessage text={AGENT_MESSAGES.adding} startFrame={72} />
              <ToolCallRow spec={TOOL_CALLS.editUsersRoute} startFrame={90} doneFrame={104} />
              <StructuredDiff
                diff={usersRouteDiff}
                startFrame={98}
                framesPerLine={3}
                highlightLines={USERS_ROUTE_FOCUS.releaseLines}
                highlightStartFrame={152}
                highlightEndFrame={186}
              />
              <ToolCallRow spec={TOOL_CALLS.editApiUsers} startFrame={170} doneFrame={182} />
              <ToolCallRow spec={TOOL_CALLS.editUserManagement} startFrame={180} doneFrame={192} />
            </TMCodeTerminal>
          </MacWindowFrame>
        </div>
      </ZoomFocus>
    </AbsoluteFill>
  )
}
