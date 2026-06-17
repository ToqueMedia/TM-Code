// Story scene 7 — Browser (150f / 5s). Tall portrait browser opens the URL and
// shows the LIVE premium page. URL/lock highlighted briefly, then page is clear.

import React from 'react'
import { AbsoluteFill } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { PublishedBrowserMock } from '../../components/general/PublishedBrowserMock'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { HighlightBox } from '../../components/HighlightBox'
import { TargetMark } from '../../components/general/debugTargets'
import { DEPLOY_URL } from '../../data/publishSteps'
import { STORY_CAPTIONS } from '../../data/storyVertical'

const B = { x: 40, y: 180, width: 1000, height: 1540 }
const ADDR = { x: B.x + 200, y: B.y + 1 + 40 + 24 }

export const StoryBrowserScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />
      <div style={{ position: 'absolute', left: B.x, top: B.y }}>
        <PublishedBrowserMock width={B.width} height={B.height} url={DEPLOY_URL} typeStartFrame={6} enterFrame={20} loadFrame={30} />
      </div>
      <HighlightBox x={B.x + 54} y={B.y + 48} width={460} height={36} startFrame={22} endFrame={64} radius={18} />
      <AnimatedCursor appearFrame={2} disappearFrame={48} keyframes={[
        { frame: 2, x: ADDR.x + 170, y: ADDR.y + 150 },
        { frame: 8, x: ADDR.x, y: ADDR.y },
        { frame: 10, x: ADDR.x, y: ADDR.y, click: true },
        { frame: 36, x: ADDR.x + 60, y: ADDR.y + 40 },
      ]} />
      <TargetMark x={540} y={ADDR.y} w={840} h={52} />
      <Caption text={STORY_CAPTIONS.online} startFrame={50} endFrame={146} position="bottom" size={56} inset={240} />
    </AbsoluteFill>
  )
}
