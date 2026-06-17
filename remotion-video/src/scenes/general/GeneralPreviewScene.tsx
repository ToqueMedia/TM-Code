import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT } from '../../data/mockProject'
import { CAPTIONS, GENERAL_TOOL_CALLS } from '../../data/generalPromoScript'
import { MacWindowFrame } from '../../components/MacWindowFrame'
import { TMCodeTerminal } from '../../components/TMCodeTerminal'
import { AgentMessage } from '../../components/AgentMessage'
import { ToolCallRow } from '../../components/ToolCallRow'
import { BrowserWindow, BROWSER_CHROME_HEIGHT } from '../../components/BrowserWindow'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { HighlightBox } from '../../components/HighlightBox'
import { SaasLandingMock, getLandingLayout } from '../../components/general/SaasLandingMock'
import { edgeFade, GeneralSceneBackground, Caption } from '../../components/general/sceneKit'

// Scene 6 split geometry (1920x1080 scene space).
const CHAT = GLAYOUT.splitChat
const BROWSER = GLAYOUT.splitBrowser

// Live preview surface (the demo app body) in scene space.
// Browser outer border 1px + chrome (tab strip + nav bar).
const BODY = { x: BROWSER.x + 1, y: BROWSER.y + 1 + BROWSER_CHROME_HEIGHT }
const MOCK_W = BROWSER.width - 2
const MOCK_H = BROWSER.height - 2 - BROWSER_CHROME_HEIGHT

// SaasLandingMock fires its button press at clickFrame; keep the cursor in sync.
const REVEAL_FRAME = 30
const CLICK_FRAME = 150

// "Join waitlist" button target, mapped from component space into scene space.
const layout = getLandingLayout(MOCK_W)
const WAITLIST = { x: BODY.x + layout.waitlistButton.x, y: BODY.y + layout.waitlistButton.y }

// HighlightBox box around the waitlist button (component-space width/height → scene space).
const HL_W = 188
const HL_H = 64

/** Scene 6 (240f) — split: chat keeps working on the left, the live preview runs on the right. */
export const GeneralPreviewScene: React.FC = () => {
  const frame = useCurrentFrame()
  const opacity = edgeFade(frame, 240)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity }}>
      <GeneralSceneBackground />

      {/* LEFT — TM Code chat keeps working while the preview is up */}
      <div style={{ position: 'absolute', left: CHAT.x, top: CHAT.y }}>
        <MacWindowFrame
          title="TM Code"
          subtitle={SAAS_PROJECT.name}
          width={CHAT.width}
          height={CHAT.height}
          entranceFrame={0}
        >
          <TMCodeTerminal
            width={CHAT.width - 2}
            height={CHAT.height - 46}
            statusLabel="working"
            statusKind="working"
            tokensText="18.4k tokens"
            elapsedText="1m 42s"
            bottomAnchor
          >
            <AgentMessage text="Preview pronto — a tua landing já corre." startFrame={0} instant />
            <ToolCallRow spec={GENERAL_TOOL_CALLS.verifyPreview} startFrame={0} doneFrame={14} />
          </TMCodeTerminal>
        </MacWindowFrame>
      </div>

      {/* RIGHT — the live preview (the star of this scene) */}
      <div style={{ position: 'absolute', left: BROWSER.x, top: BROWSER.y }}>
        <BrowserWindow
          title="SaaS Demo"
          url="http://localhost:5173"
          width={BROWSER.width}
          height={BROWSER.height}
          entranceFrame={6}
          accent={tokens.colors.accent.blue}
        >
          <SaasLandingMock
            width={MOCK_W}
            height={MOCK_H}
            revealFrame={REVEAL_FRAME}
            clickFrame={CLICK_FRAME}
          />
        </BrowserWindow>
      </div>

      {/* The waitlist button lights up right after the click. */}
      <HighlightBox
        x={WAITLIST.x - HL_W / 2}
        y={WAITLIST.y - HL_H / 2}
        width={HL_W}
        height={HL_H}
        startFrame={CLICK_FRAME + 5}
        endFrame={185}
        radius={tokens.radius.pill}
      />

      {/* Cursor in screen space — drifts onto the waitlist button and clicks. */}
      <AnimatedCursor
        appearFrame={120}
        keyframes={[
          { frame: 120, x: WAITLIST.x + 140, y: WAITLIST.y + 90 },
          { frame: 148, x: WAITLIST.x, y: WAITLIST.y },
          { frame: CLICK_FRAME, x: WAITLIST.x, y: WAITLIST.y, click: true },
          { frame: 200, x: WAITLIST.x - 80, y: WAITLIST.y + 60 },
        ]}
      />

      <Caption text={CAPTIONS.preview} position="bottom" startFrame={40} endFrame={210} />
    </AbsoluteFill>
  )
}
