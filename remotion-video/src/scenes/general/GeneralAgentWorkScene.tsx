// Scene 4 of the general promo — "the agent really works". A centered IDE
// window holds the two-column Chat Mode body: on the left, the agent reasons
// (ReasoningBlockMock) and then runs a cascade of tool calls (read → search →
// edit → edit → edit → test → verify) interleaved with short plain-language
// updates; the right column stays a dim preview (the live app comes in scene 6).
// A gentle ZoomFocus pushes in on the chat column during the cascade. All motion
// is frame-driven; colors from tokens.

import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT, GENERAL_PROMPT_TEXT } from '../../data/mockProject'
import { GENERAL_MESSAGES, GENERAL_TOOL_CALLS, CAPTIONS } from '../../data/generalPromoScript'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { ToolCallRow } from '../../components/ToolCallRow'
import { ZoomFocus } from '../../components/ZoomFocus'
import { ChatModeMock } from '../../components/general/ChatModeMock'
import { ChatMessageBubble } from '../../components/general/ChatMessageBubble'
import { ReasoningBlockMock } from '../../components/general/ReasoningBlockMock'
import { GeneralSceneBackground, Caption, edgeFade } from '../../components/general/sceneKit'

const SCENE_DURATION = 300

export const GeneralAgentWorkScene: React.FC = () => {
  const frame = useCurrentFrame()

  return (
    <AbsoluteFill
      style={{ backgroundColor: tokens.colors.bg.app, opacity: edgeFade(frame, SCENE_DURATION) }}
    >
      <GeneralSceneBackground />
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1, x: 960, y: 540 },
          { frame: 120, scale: 1.12, x: 720, y: 600 },
          { frame: 200, scale: 1.12, x: 720, y: 600 },
          { frame: 240, scale: 1, x: 960, y: 540 },
        ]}
      >
        <div style={{ position: 'absolute', left: GLAYOUT.window.x, top: GLAYOUT.window.y }}>
          <MacWindowFrame
            title="TM Code"
            subtitle={SAAS_PROJECT.name}
            width={GLAYOUT.window.width}
            height={GLAYOUT.window.height}
          >
            <ChatModeMock
              width={GLAYOUT.window.width - 2}
              height={GLAYOUT.window.height - TITLEBAR_HEIGHT - 2}
              leftRatio={0.5}
              previewDim
              chatBottomAnchor
              chat={
                <>
                  <ChatMessageBubble role="user" text={GENERAL_PROMPT_TEXT} startFrame={0} instant />
                  <ReasoningBlockMock startFrame={10} activeUntilFrame={72} />
                  <ChatMessageBubble role="assistant" text={GENERAL_MESSAGES.plan} startFrame={76} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.readApp} startFrame={92} doneFrame={108} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.searchAuth} startFrame={104} doneFrame={122} />
                  <ChatMessageBubble role="assistant" text={GENERAL_MESSAGES.found} startFrame={120} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.editHero} startFrame={134} doneFrame={150} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.editAuth} startFrame={150} doneFrame={166} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.editLanding} startFrame={166} doneFrame={184} />
                  <ChatMessageBubble role="assistant" text={GENERAL_MESSAGES.building} startFrame={188} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.runTests} startFrame={206} doneFrame={230} />
                  <ToolCallRow spec={GENERAL_TOOL_CALLS.verifyPreview} startFrame={232} doneFrame={248} />
                  <ChatMessageBubble role="assistant" text={GENERAL_MESSAGES.done} startFrame={256} />
                </>
              }
            />
          </MacWindowFrame>
        </div>
      </ZoomFocus>
      <Caption text={CAPTIONS.work} position="top" startFrame={24} endFrame={130} />
    </AbsoluteFill>
  )
}
