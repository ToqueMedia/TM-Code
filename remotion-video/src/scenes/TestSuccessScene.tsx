import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { LAYOUT } from '../data/sceneTiming'
import { AGENT_MESSAGES, PROJECT, TOOL_CALLS, WORKED_FOR_TEXT } from '../data/agentScript'
import { DEMO_APP } from '../data/mockUsers'
import { MacWindowFrame } from '../components/MacWindowFrame'
import { TMCodeTerminal } from '../components/TMCodeTerminal'
import { AgentMessage } from '../components/AgentMessage'
import { ToolCallRow } from '../components/ToolCallRow'
import { TestRunnerOutput } from '../components/TestRunnerOutput'
import { BrowserWindow, BROWSER_CHROME_HEIGHT } from '../components/BrowserWindow'
import { ReceptionLoginMock, getLoginLayout } from '../components/ReceptionLoginMock'
import { AnimatedCursor } from '../components/AnimatedCursor'
import { ZoomFocus } from '../components/ZoomFocus'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const LB = LAYOUT.loginBrowser
const TWIN = LAYOUT.terminalWindow

const LOGIN_W = LB.width - 2
const LOGIN_H = LB.height - 2 - BROWSER_CHROME_HEIGHT
const LOGIN_BODY = { x: LB.x + 1, y: LB.y + 1 + BROWSER_CHROME_HEIGHT }
const loginLayout = getLoginLayout(LOGIN_W, LOGIN_H)
const ENTRAR_BTN = {
  x: LOGIN_BODY.x + loginLayout.submitButton.x,
  y: LOGIN_BODY.y + loginLayout.submitButton.y,
}

/** Scene 6 (180f) — the reception user logs in again; tests pass; the agent closes the loop. */
export const TestSuccessScene: React.FC = () => {
  const frame = useCurrentFrame()

  const sceneOpacity =
    interpolate(frame, [0, 6], [0, 1], clamp) * interpolate(frame, [174, 180], [1, 0], clamp)
  const partAOpacity = interpolate(frame, [80, 88], [1, 0], clamp)
  const partBOpacity = interpolate(frame, [85, 93], [0, 1], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: sceneOpacity }}>
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1, x: 960, y: 540 },
          { frame: 130, scale: 1, x: 960, y: 540 },
          // push on "4 passed (3.2s)" + final agent message (bottom-anchored content)
          { frame: 148, scale: 1.18, x: 830, y: 620 },
          { frame: 170, scale: 1.18, x: 830, y: 620 },
          { frame: 179, scale: 1.08, x: 900, y: 580 },
        ]}
      >
        {/* PART A — reception login succeeds */}
        {frame < 90 ? (
          <div style={{ position: 'absolute', inset: 0, opacity: partAOpacity }}>
            <div style={{ position: 'absolute', left: LB.x, top: LB.y }}>
              <BrowserWindow
                title={DEMO_APP.name}
                url={DEMO_APP.loginUrl}
                width={LB.width}
                height={LB.height}
                entranceFrame={0}
              >
                <ReceptionLoginMock
                  width={LOGIN_W}
                  height={LOGIN_H}
                  submitFrame={44}
                  successFrame={60}
                  welcomeFrame={74}
                />
              </BrowserWindow>
            </div>
            <AnimatedCursor
              appearFrame={12}
              disappearFrame={62}
              keyframes={[
                { frame: 12, x: 1180, y: 850 },
                { frame: 38, x: ENTRAR_BTN.x, y: ENTRAR_BTN.y },
                { frame: 44, x: ENTRAR_BTN.x, y: ENTRAR_BTN.y, click: true },
              ]}
            />
          </div>
        ) : null}

        {/* PART B — tests pass in TM Code */}
        {frame >= 85 ? (
          <div style={{ position: 'absolute', inset: 0, opacity: partBOpacity }}>
            <div style={{ position: 'absolute', left: TWIN.x, top: TWIN.y }}>
              <MacWindowFrame
                title="TM Code"
                subtitle={PROJECT.name}
                width={TWIN.width}
                height={TWIN.height}
              >
                <TMCodeTerminal
                  width={TWIN.width - 2}
                  height={TWIN.height - 46}
                  statusLabel={frame >= 150 ? 'ready' : 'working'}
                  statusKind={frame >= 150 ? 'ready' : 'working'}
                  tokensText="18.6k tokens"
                  elapsedText="1m 32s"
                  bottomAnchor
                >
                  {/* /te2e steps from scene 5, already settled */}
                  <ToolCallRow spec={TOOL_CALLS.te2eClickConfirm} startFrame={-30} doneFrame={-20} />
                  <ToolCallRow spec={TOOL_CALLS.te2eAssert} startFrame={-30} doneFrame={-20} />
                  {/* the /te2e validation report */}
                  <TestRunnerOutput
                    startFrame={88}
                    prefix="❯ "
                    prefixColor={tokens.colors.chat.userRail}
                  />
                  <AgentMessage text={AGENT_MESSAGES.done} startFrame={152} charsPerFrame={3.5} />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginTop: 6,
                      opacity: interpolate(frame, [172, 178], [0, 1], clamp),
                    }}
                  >
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
          </div>
        ) : null}
      </ZoomFocus>
    </AbsoluteFill>
  )
}
