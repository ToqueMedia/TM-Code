// Open URL — the proof. A browser springs in, the cursor clicks the address bar,
// the deployed URL is pasted (URL/lock highlighted), Enter loads it, and the
// published PREMIUM page (the #design version) appears. Continuous, no fade.

import React from 'react'
import { AbsoluteFill } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { PublishedBrowserMock } from '../../components/general/PublishedBrowserMock'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { HighlightBox } from '../../components/HighlightBox'
import { ZoomFocus } from '../../components/ZoomFocus'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { DEPLOY_URL } from '../../data/publishSteps'
import { OVERLAY_TEXT } from '../../data/generalPromoScript'

const B = GLAYOUT.browser
const ADDR = { x: B.x + 200, y: B.y + 1 + 40 + 24 }

export const GeneralOpenBrowserScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />
      <ZoomFocus
        width={1920}
        height={1080}
        keyframes={[
          { frame: 0, scale: 1, x: 960, y: 540 },
          { frame: 44, scale: 1, x: 960, y: 540 },
          { frame: 60, scale: 1.06, x: 960, y: 540 },
          { frame: 156, scale: 1.06, x: 960, y: 540 },
          { frame: 204, scale: 0.93, x: 960, y: 540 },
        ]}
      >
        <div style={{ position: 'absolute', left: B.x, top: B.y }}>
          <PublishedBrowserMock width={B.width} height={B.height} url={DEPLOY_URL} typeStartFrame={14} enterFrame={46} loadFrame={58} />
        </div>
        {/* Emphasize the URL + lock briefly. */}
        <HighlightBox x={B.x + 54} y={B.y + 48} width={430} height={36} startFrame={40} endFrame={86} radius={18} />
        <AnimatedCursor
          appearFrame={2}
          disappearFrame={56}
          keyframes={[
            { frame: 2, x: ADDR.x + 170, y: ADDR.y + 150 },
            { frame: 10, x: ADDR.x, y: ADDR.y },
            { frame: 12, x: ADDR.x, y: ADDR.y, click: true },
            { frame: 40, x: ADDR.x + 60, y: ADDR.y + 40 },
          ]}
        />
      </ZoomFocus>
      <Caption text={OVERLAY_TEXT.online} startFrame={84} endFrame={196} position="bottom" size={30} />
    </AbsoluteFill>
  )
}
