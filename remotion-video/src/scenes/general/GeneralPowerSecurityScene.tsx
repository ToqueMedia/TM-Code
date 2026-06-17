// Scene 8 of the general promo — the "power + security" montage. Four fast cuts
// (~45 frames each), each crisply fading in/out so they feel like hard edits:
//   A — Terminal Mode greeting (agentic terminal)
//   B — `npm test` running in the PTY (green checks)
//   C — a permission prompt the user authorizes (Allow click)
//   D — an AI-generated git commit message (sparkle press → typewriter)
// A single shared dark background sits under every cut. Frame-driven only:
// motion comes from useCurrentFrame()/interpolate()/the components' own springs;
// no CSS transitions, no randomness. Colors come from tokens.

import React from 'react'
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { CAPTIONS } from '../../data/generalPromoScript'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { TMCodeTerminal } from '../../components/TMCodeTerminal'
import { StatusLine } from '../../components/StatusLine'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { GeneralTerminalGreeting } from '../../components/general/GeneralTerminalGreeting'
import { GeneralTestOutput } from '../../components/general/GeneralTestOutput'
import {
  PermissionPromptMock,
  PERMISSION_LAYOUT,
} from '../../components/general/PermissionPromptMock'
import {
  SourceControlMock,
  getSourceControlLayout,
} from '../../components/general/SourceControlMock'
import { Caption, GeneralSceneBackground, edgeFade } from '../../components/general/sceneKit'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// Each cut spans 45 frames; cuts fade in over the first FADE frames and out over
// the last FADE frames so the montage reads as a sequence of hard-ish edits.
const CUT = 45
const FADE = 6

/** Opacity that fades in/out at the cut's edges (frames local to the cut). */
const cutFade = (frame: number): number =>
  interpolate(frame, [0, FADE], [0, 1], CLAMP) *
  interpolate(frame, [CUT - FADE, CUT], [1, 0], CLAMP)

// Demo window geometry shared by the terminal cuts (A & B).
const WIN_W = 1280
const WIN_H = 760
// MacWindowFrame body: width − 2 borders, height − titlebar − bottom border (the
// existing scenes use height − 46).
const BODY_W = WIN_W - 2
const BODY_H = WIN_H - 46

// Source-control window (cut D) — narrower panel so the commit box reads large.
const SC_WIN_W = 720
const SC_WIN_H = 620
const SC_BODY_W = SC_WIN_W - 2
const SC_BODY_H = SC_WIN_H - 46
// Window top-left when centered on the 1920×1080 stage.
const SC_WIN_LEFT = 960 - SC_WIN_W / 2
const SC_WIN_TOP = 540 - SC_WIN_H / 2

/** Center the children of a cut on the stage. */
const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    {children}
  </AbsoluteFill>
)

// ── CUT A: Terminal Mode greeting ───────────────────────────────────────────
const CutTerminalGreeting: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ opacity: cutFade(frame) }}>
      <Centered>
        <MacWindowFrame title="TM Code" subtitle="Terminal" width={WIN_W} height={WIN_H}>
          <div
            style={{
              width: BODY_W,
              height: BODY_H,
              display: 'flex',
              flexDirection: 'column',
              background: tokens.colors.bg.terminal,
            }}
          >
            <div style={{ flex: 1, overflow: 'hidden', padding: '26px 30px' }}>
              <GeneralTerminalGreeting startFrame={2} />
            </div>
            <StatusLine label="ready" kind="ready" />
          </div>
        </MacWindowFrame>
      </Centered>
      <Caption text={CAPTIONS.powerTerminal} position="top" startFrame={4} size={40} />
    </AbsoluteFill>
  )
}

// ── CUT B: npm test in the PTY ──────────────────────────────────────────────
const CutTestRun: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ opacity: cutFade(frame) }}>
      <Centered>
        <MacWindowFrame title="TM Code" subtitle="Terminal" width={WIN_W} height={WIN_H}>
          <TMCodeTerminal
            width={BODY_W}
            height={BODY_H}
            statusLabel="working"
            statusKind="working"
            elapsedText="3.2s"
            bottomAnchor
          >
            <GeneralTestOutput startFrame={2} />
          </TMCodeTerminal>
        </MacWindowFrame>
      </Centered>
      <Caption text={CAPTIONS.powerTerminal} position="top" startFrame={4} size={40} />
    </AbsoluteFill>
  )
}

// ── CUT C: permission prompt (the user authorizes) ──────────────────────────
const CutPermission: React.FC = () => {
  const frame = useCurrentFrame()
  // Allow button center on the stage: the modal centers itself (panel center =
  // 960,540), and the Allow button sits at PERMISSION_LAYOUT.allowButtonOffset.
  const allowX = 960 + PERMISSION_LAYOUT.allowButtonOffset.x
  const allowY = 540 + PERMISSION_LAYOUT.allowButtonOffset.y
  return (
    <AbsoluteFill style={{ opacity: cutFade(frame) }}>
      {/* Dim terminal backdrop behind the modal. */}
      <Centered>
        <MacWindowFrame
          title="TM Code"
          subtitle="Terminal"
          width={WIN_W}
          height={WIN_H}
          style={{ filter: 'brightness(0.5)' }}
        >
          <TMCodeTerminal
            width={BODY_W}
            height={BODY_H}
            statusLabel="working"
            statusKind="working"
            bottomAnchor
          >
            <GeneralTestOutput startFrame={2} />
          </TMCodeTerminal>
        </MacWindowFrame>
      </Centered>
      {/* Self-centering modal — full-screen so 960,540 math holds. */}
      <PermissionPromptMock
        startFrame={2}
        allowPressFrame={30}
        commandText="execute  .  npm run deploy"
      />
      <AnimatedCursor
        keyframes={[
          { frame: 6, x: allowX - 150, y: allowY + 110 },
          { frame: 28, x: allowX, y: allowY },
          { frame: 30, x: allowX, y: allowY, click: true },
        ]}
        appearFrame={6}
      />
      <Caption text={CAPTIONS.powerPerm} position="top" startFrame={4} size={40} />
    </AbsoluteFill>
  )
}

// ── CUT D: git commit message written by the AI ─────────────────────────────
const CutGitCommit: React.FC = () => {
  const frame = useCurrentFrame()
  const layout = getSourceControlLayout(SC_BODY_W)
  // Sparkle button center in stage space: window left/top + body inset (1px
  // border, TITLEBAR_HEIGHT) + the layout offset within the panel.
  const sparkleX = SC_WIN_LEFT + 1 + layout.sparkleButton.x
  const sparkleY = SC_WIN_TOP + TITLEBAR_HEIGHT + layout.sparkleButton.y
  return (
    <AbsoluteFill style={{ opacity: cutFade(frame) }}>
      <div
        style={{
          position: 'absolute',
          left: SC_WIN_LEFT,
          top: SC_WIN_TOP,
          width: SC_WIN_W,
          height: SC_WIN_H,
        }}
      >
        <MacWindowFrame title="TM Code" subtitle="Source Control" width={SC_WIN_W} height={SC_WIN_H}>
          <div style={{ width: SC_BODY_W, height: SC_BODY_H, background: tokens.colors.bg.panel }}>
            <SourceControlMock
              startFrame={2}
              sparkleFrame={14}
              commitTypeFrame={22}
              width={SC_BODY_W}
              height={SC_BODY_H}
            />
          </div>
        </MacWindowFrame>
      </div>
      <AnimatedCursor
        keyframes={[
          { frame: 6, x: sparkleX - 130, y: sparkleY + 90 },
          { frame: 13, x: sparkleX, y: sparkleY },
          { frame: 14, x: sparkleX, y: sparkleY, click: true },
        ]}
        appearFrame={6}
      />
      <Caption text={CAPTIONS.powerGit} position="top" startFrame={4} size={40} />
    </AbsoluteFill>
  )
}

/**
 * Power + security montage: four self-contained cuts laid out on a shared dark
 * background. Each cut is a 45-frame <Sequence> (frames reset to 0 inside), and
 * each cross-fades at its own edges so the montage reads crisp.
 */
export const GeneralPowerSecurityScene: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: edgeFade(frame, 180) }}>
      <GeneralSceneBackground />
      <Sequence from={0} durationInFrames={CUT} layout="none">
        <CutTerminalGreeting />
      </Sequence>
      <Sequence from={CUT} durationInFrames={CUT} layout="none">
        <CutTestRun />
      </Sequence>
      <Sequence from={CUT * 2} durationInFrames={CUT} layout="none">
        <CutPermission />
      </Sequence>
      <Sequence from={CUT * 3} durationInFrames={CUT} layout="none">
        <CutGitCommit />
      </Sequence>
    </AbsoluteFill>
  )
}
