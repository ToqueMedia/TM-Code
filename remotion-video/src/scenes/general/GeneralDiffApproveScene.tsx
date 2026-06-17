// General promo — Scene 5 (210f): the hero diff reveals while the camera dives
// into the hunk, then the camera returns to scale 1 and the user APPROVES the
// change with a cursor click. All motion is frame-driven (useCurrentFrame +
// interpolate/spring). Coordinates for the cursor live in 1920x1080 SCENE space
// (the cursor is a child of ZoomFocus, so it tracks the camera) and the Approve
// button is rendered in a FIXED absolutely-positioned container inside the
// window body so its on-screen rect is deterministic despite the bottom-anchored
// flexbox layout of TMCodeTerminal.

import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT } from '../../data/mockProject'
import { CAPTIONS, GENERAL_TOOL_CALLS } from '../../data/generalPromoScript'
import { heroDiff, HERO_FOCUS } from '../../data/generalPromoDiff'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { TMCodeTerminal } from '../../components/TMCodeTerminal'
import { AgentMessage } from '../../components/AgentMessage'
import { ToolCallRow } from '../../components/ToolCallRow'
import { StructuredDiff } from '../../components/StructuredDiff'
import { ZoomFocus } from '../../components/ZoomFocus'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { HighlightBox } from '../../components/HighlightBox'
import { Toast } from '../../components/Toast'
import { ApprovalButtonsMock, APPROVAL_LAYOUT } from '../../components/general/ApprovalButtonsMock'
import { GeneralSceneBackground, Caption, edgeFade } from '../../components/general/sceneKit'

const DURATION = 210

const W = GLAYOUT.window
const TERM_W = W.width - 2
const TERM_H = W.height - 46

// Fixed approval-row rect inside the window body, in SCENE (1920x1080) space.
// We position it absolutely relative to the window-placement div (left=W.x,
// top=W.y), so it does NOT depend on TMCodeTerminal's bottom-anchored flow —
// which makes the cursor target deterministic. The row sits just above the
// StatusLine at the bottom of the body.
const APPROVE_ROW_WIDTH = 760
const APPROVE_ROW_LEFT_IN_WINDOW = 40 // offset from the window's left edge
const APPROVE_ROW_TOP_IN_WINDOW = 800 // offset from the window's top edge

// Scene-space rect of the approval row.
const ROW_LEFT = W.x + APPROVE_ROW_LEFT_IN_WINDOW
const ROW_TOP = W.y + APPROVE_ROW_TOP_IN_WINDOW

// Approve button center in scene space (see APPROVAL_LAYOUT contract).
const APPROVE_X = ROW_LEFT + APPROVE_ROW_WIDTH - APPROVAL_LAYOUT.approveFromRight
const APPROVE_Y = ROW_TOP + APPROVAL_LAYOUT.centerY

/**
 * Scene 5 — hero diff reveal + approve. The camera focuses the diff hunk, then
 * returns to scale 1 before the cursor click so screen coordinates are stable.
 */
export const GeneralDiffApproveScene: React.FC = () => {
  const frame = useCurrentFrame()
  const opacity = edgeFade(frame, DURATION)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity }}>
      <GeneralSceneBackground />

      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1, x: 960, y: 540 },
          { frame: 40, scale: 1, x: 960, y: 540 },
          // dive into the revealing diff hunk
          { frame: 70, scale: 1.28, x: 780, y: 640 },
          { frame: 150, scale: 1.28, x: 800, y: 645 },
          // return to scale 1 BEFORE the cursor click → stable screen coords
          { frame: 160, scale: 1, x: 960, y: 540 },
          { frame: 209, scale: 1, x: 960, y: 540 },
        ]}
      >
        <div style={{ position: 'absolute', left: W.x, top: W.y }}>
          <MacWindowFrame title="TM Code" subtitle={SAAS_PROJECT.name} width={W.width} height={W.height}>
            <TMCodeTerminal
              width={TERM_W}
              height={TERM_H}
              statusLabel="working"
              statusKind="working"
              tokensText="8.4k tokens"
              elapsedText="38s"
              bottomAnchor
            >
              <AgentMessage text="Vou aplicar esta alteracao ao Hero." startFrame={0} instant />
              <ToolCallRow spec={GENERAL_TOOL_CALLS.editHero} startFrame={0} doneFrame={12} />
              <StructuredDiff
                diff={heroDiff}
                startFrame={18}
                framesPerLine={4}
                fontSize={22}
                highlightLines={HERO_FOCUS}
                highlightStartFrame={100}
                highlightEndFrame={150}
              />
            </TMCodeTerminal>
          </MacWindowFrame>

          {/* Fixed approval-row overlay: known on-screen rect for the cursor.
              Positioned relative to the window-placement div, inside the body
              (below the titlebar), so its scene-space position never shifts. */}
          <div
            style={{
              position: 'absolute',
              left: APPROVE_ROW_LEFT_IN_WINDOW,
              top: APPROVE_ROW_TOP_IN_WINDOW,
              width: APPROVE_ROW_WIDTH,
            }}
          >
            <ApprovalButtonsMock
              startFrame={120}
              approvePressFrame={168}
              approvedFrame={176}
              width={APPROVE_ROW_WIDTH}
            />
          </div>
        </div>

        {/* Attention box around the highlighted hero lines, drawn during the
            zoom. Estimated rect around the diff hunk focal area (scene space). */}
        <HighlightBox
          x={W.x + 30}
          y={W.y + TITLEBAR_HEIGHT + 470}
          width={1180}
          height={140}
          startFrame={104}
          endFrame={150}
        />

        {/* Cursor lives in scene space (child of ZoomFocus) and aims at the
            deterministic Approve button center, clicking at frame 168. */}
        <AnimatedCursor
          appearFrame={150}
          keyframes={[
            { frame: 150, x: APPROVE_X + 220, y: APPROVE_Y - 140 },
            { frame: 166, x: APPROVE_X, y: APPROVE_Y },
            { frame: 168, x: APPROVE_X, y: APPROVE_Y, click: true },
            { frame: 188, x: APPROVE_X - 8, y: APPROVE_Y + 10 },
          ]}
        />
      </ZoomFocus>

      <Caption text={CAPTIONS.diff} position="bottom" startFrame={28} endFrame={108} />

      <Toast text="Alteracao aplicada." startFrame={180} holdFrames={26} />
    </AbsoluteFill>
  )
}
