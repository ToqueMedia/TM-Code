import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { LAYOUT } from '../data/sceneTiming'
import { AGENT_MESSAGES, PROJECT, TE2E, TOOL_CALLS } from '../data/agentScript'
import { DEMO_APP, TOAST_TEXT } from '../data/mockUsers'
import { MacWindowFrame } from '../components/MacWindowFrame'
import { TMCodeTerminal } from '../components/TMCodeTerminal'
import { AgentMessage } from '../components/AgentMessage'
import { UserPrompt } from '../components/UserPrompt'
import { ToolCallRow } from '../components/ToolCallRow'
import { BrowserWindow, BROWSER_CHROME_HEIGHT } from '../components/BrowserWindow'
import { AdminUserManagementMock, getAdminLayout } from '../components/AdminUserManagementMock'
import { ConfirmModal, MODAL_LAYOUT } from '../components/ConfirmModal'
import { Toast } from '../components/Toast'
import { AnimatedCursor } from '../components/AnimatedCursor'
import { HighlightBox } from '../components/HighlightBox'
import { ZoomFocus } from '../components/ZoomFocus'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const TW = LAYOUT.splitTerminal
const BW = LAYOUT.splitBrowser

// Browser body (the demo app surface) in 1920x1080 scene space:
// outer border 1px + chrome (tab strip 40 + nav 48).
const BODY = { x: BW.x + 1, y: BW.y + 1 + BROWSER_CHROME_HEIGHT }
const MOCK_W = BW.width - 2
const MOCK_H = BW.height - 2 - BROWSER_CHROME_HEIGHT

const admin = getAdminLayout(MOCK_W)
const FORCE_BTN = { x: BODY.x + admin.forceLogoutButton.x, y: BODY.y + admin.forceLogoutButton.y }
const BADGE = {
  x: BODY.x + admin.statusBadge.x,
  y: BODY.y + admin.statusBadge.y,
  width: admin.statusBadge.width,
  height: admin.statusBadge.height,
}
// ConfirmModal centers its panel in the browser body.
const CONFIRM_BTN = {
  x: BODY.x + MOCK_W / 2 + MODAL_LAYOUT.confirmButtonOffset.x,
  y: BODY.y + MOCK_H / 2 + MODAL_LAYOUT.confirmButtonOffset.y,
}

/** Scene 5 (210f) — split screen: tests run on the left, the admin frees the station on the right. */
export const E2EDemoScene: React.FC = () => {
  const frame = useCurrentFrame()

  const opacity =
    interpolate(frame, [0, 6], [0, 1], clamp) * interpolate(frame, [204, 210], [1, 0], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity }}>
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1, x: 960, y: 540 },
          { frame: 40, scale: 1, x: 960, y: 540 },
          // toward the Forçar logout button (right edge — keep pan in bounds)
          { frame: 56, scale: 1.35, x: 1200, y: 430 },
          // the confirmation modal (browser body center ≈ y 554)
          { frame: 70, scale: 1.5, x: 1280, y: 554 },
          { frame: 106, scale: 1.5, x: 1280, y: 554 },
          // badge flip + toast bottom-right, both inside the shot
          { frame: 122, scale: 1.4, x: 1234, y: 620 },
          { frame: 152, scale: 1.4, x: 1234, y: 620 },
          { frame: 176, scale: 1, x: 960, y: 540 },
        ]}
      >
        {/* LEFT — TM Code keeps working */}
        <div style={{ position: 'absolute', left: TW.x, top: TW.y }}>
          <MacWindowFrame
            title="TM Code"
            subtitle={PROJECT.name}
            width={TW.width}
            height={TW.height}
            entranceFrame={0}
          >
            <TMCodeTerminal
              width={TW.width - 2}
              height={TW.height - 46}
              statusLabel="working"
              statusKind="working"
              tokensText="15.2k tokens"
              elapsedText="1m 18s"
              bottomAnchor
            >
              {/* /te2e run: the user's command echoed, then the agent drives the
                  browser on the right — each step lands as a tool call here,
                  synced with the cursor clicks (58 and 102). */}
              <UserPrompt text={TE2E.typed} startFrame={0} instant />
              <AgentMessage text={AGENT_MESSAGES.te2eStart} startFrame={4} />
              <ToolCallRow spec={TOOL_CALLS.te2eOpen} startFrame={16} doneFrame={30} />
              <ToolCallRow spec={TOOL_CALLS.te2eClickLogout} startFrame={50} doneFrame={62} />
              <ToolCallRow spec={TOOL_CALLS.te2eClickConfirm} startFrame={96} doneFrame={106} />
              <ToolCallRow spec={TOOL_CALLS.te2eAssert} startFrame={120} doneFrame={136} />
            </TMCodeTerminal>
          </MacWindowFrame>
        </div>

        {/* RIGHT — Katondo Queue admin */}
        <div style={{ position: 'absolute', left: BW.x, top: BW.y }}>
          <BrowserWindow
            title={DEMO_APP.name}
            url={DEMO_APP.adminUrl}
            width={BW.width}
            height={BW.height}
            entranceFrame={4}
          >
            <AdminUserManagementMock
              width={MOCK_W}
              height={MOCK_H}
              statusSwitchFrame={112}
              buttonPressFrame={58}
            />
            <ConfirmModal startFrame={64} confirmPressFrame={102} closeFrame={108} />
            <Toast text={TOAST_TEXT} startFrame={118} holdFrames={64} />
          </BrowserWindow>
        </div>

        {/* Badge flips to "Disponível" — underline it while the camera hovers */}
        <HighlightBox
          x={BADGE.x - BADGE.width / 2 - 12}
          y={BADGE.y - BADGE.height / 2 - 10}
          width={BADGE.width + 24}
          height={BADGE.height + 20}
          startFrame={134}
          endFrame={168}
        />

        <AnimatedCursor
          appearFrame={22}
          keyframes={[
            { frame: 22, x: 1480, y: 380 },
            { frame: 52, x: FORCE_BTN.x, y: FORCE_BTN.y },
            { frame: 58, x: FORCE_BTN.x, y: FORCE_BTN.y, click: true },
            { frame: 84, x: 1620, y: 500 },
            { frame: 98, x: CONFIRM_BTN.x, y: CONFIRM_BTN.y },
            { frame: 102, x: CONFIRM_BTN.x, y: CONFIRM_BTN.y, click: true },
            { frame: 126, x: 1600, y: 700 },
            { frame: 150, x: 1620, y: 765 },
          ]}
        />
      </ZoomFocus>
    </AbsoluteFill>
  )
}
