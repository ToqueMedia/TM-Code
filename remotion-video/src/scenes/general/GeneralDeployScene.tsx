// Scene 7 of the general promo — one-click deploy. A subdued IDE backdrop (a
// finished chat that says it is ready to publish) sits dimmed behind a
// PublishModalMock that runs its deploy steps to "Live!", then the user moves
// the cursor to the URL pill's copy button and clicks, firing a success toast.
// Frame-driven only; the modal centers itself (inset 0) so it pops dead-center.

import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground, edgeFade } from '../../components/general/sceneKit'
import { MacWindowFrame } from '../../components/MacWindowFrame'
import { AgentMessage } from '../../components/AgentMessage'
import { Toast } from '../../components/Toast'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { PublishModalMock, PUBLISH_MODAL_LAYOUT } from '../../components/general/PublishModalMock'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT } from '../../data/mockProject'
import { CAPTIONS } from '../../data/generalPromoScript'
import { PUBLISH_COPY } from '../../data/publishSteps'

// Copy-button screen center: the modal is centered on screen (960, 540) and the
// layout offset is relative to the panel center.
const COPY_X = 960 + PUBLISH_MODAL_LAYOUT.copyButtonOffset.x
const COPY_Y = 540 + PUBLISH_MODAL_LAYOUT.copyButtonOffset.y

export const GeneralDeployScene: React.FC = () => {
  const frame = useCurrentFrame()

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app, opacity: edgeFade(frame, 240) }}>
      <GeneralSceneBackground />

      {/* Subdued IDE backdrop — a finished chat, dimmed so the modal pops. */}
      <AbsoluteFill style={{ opacity: 0.5 }}>
        <div style={{ position: 'absolute', left: GLAYOUT.window.x, top: GLAYOUT.window.y }}>
          <MacWindowFrame
            title="TM Code"
            subtitle={SAAS_PROJECT.name}
            width={GLAYOUT.window.width}
            height={GLAYOUT.window.height}
            style={{ transform: 'scale(0.98)' }}
          >
            <div style={{ padding: '26px 30px', fontFamily: tokens.fontFamily.ui }}>
              <AgentMessage text="Pronto para publicar." startFrame={0} instant />
            </div>
          </MacWindowFrame>
        </div>
      </AbsoluteFill>

      {/* Publish modal — centers itself (inset 0) on a full-screen layer. */}
      <AbsoluteFill>
        <PublishModalMock startFrame={10} perStepFrames={18} liveFrame={150} copyPressFrame={196} />
      </AbsoluteFill>

      {/* Cursor moves to the copy button and clicks at 196 (screen space). */}
      <AnimatedCursor
        appearFrame={175}
        keyframes={[
          { frame: 175, x: COPY_X - 220, y: COPY_Y + 150 },
          { frame: 196, x: COPY_X, y: COPY_Y, click: true },
          { frame: 240, x: COPY_X, y: COPY_Y },
        ]}
      />

      <Toast text={PUBLISH_COPY.copied} startFrame={200} holdFrames={40} />

      <Caption text={CAPTIONS.deploy} position="top" startFrame={20} endFrame={140} size={42} />
    </AbsoluteFill>
  )
}
