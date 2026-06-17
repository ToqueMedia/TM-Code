// Scene 3 of the general promo — Chat Mode, chat-first. A centered IDE window
// holds the two-column Chat Mode body: a greeting bubble on the left and a
// prompt bar where the user types a natural-language request. The right column
// stays a dim preview placeholder (nothing built yet). Frame-driven only;
// static camera (no ZoomFocus).

import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT, GENERAL_PROMPT_TEXT } from '../../data/mockProject'
import { CAPTIONS } from '../../data/generalPromoScript'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { ChatModeMock } from '../../components/general/ChatModeMock'
import { ChatMessageBubble } from '../../components/general/ChatMessageBubble'
import { PromptBarMock } from '../../components/general/PromptBarMock'
import { GeneralSceneBackground, Caption, edgeFade } from '../../components/general/sceneKit'

export const GeneralPromptScene: React.FC = () => {
  const frame = useCurrentFrame()

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: edgeFade(frame, 180) }}>
      <GeneralSceneBackground />
      <div style={{ position: 'absolute', left: GLAYOUT.window.x, top: GLAYOUT.window.y }}>
        <MacWindowFrame
          title="TM Code"
          subtitle={SAAS_PROJECT.name}
          entranceFrame={4}
          width={GLAYOUT.window.width}
          height={GLAYOUT.window.height}
        >
          <ChatModeMock
            width={GLAYOUT.window.width - 2}
            height={GLAYOUT.window.height - TITLEBAR_HEIGHT - 2}
            leftRatio={0.5}
            previewDim
            chatBottomAnchor={false}
            chat={
              <ChatMessageBubble
                role="assistant"
                text="Ola! O que queres construir hoje?"
                startFrame={10}
                instant
              />
            }
            promptBar={
              <PromptBarMock text={GENERAL_PROMPT_TEXT} startFrame={20} charsPerFrame={1.3} />
            }
          />
        </MacWindowFrame>
      </div>
      <Caption text={CAPTIONS.prompt} position="bottom" startFrame={34} endFrame={165} />
    </AbsoluteFill>
  )
}
