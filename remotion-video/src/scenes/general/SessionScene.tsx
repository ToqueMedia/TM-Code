// The ONE persistent Chat-Mode session. A single window + single preview that
// accumulate the whole conversation (ChatTimeline) and transform over time; the
// camera, cursors, connecting cue, deploy modal and badges all read the same
// session-local frame. Title cards render on top of this from the timeline.

import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GeneralSceneBackground } from '../../components/general/sceneKit'
import { ChatWindow, CHAT_BODY, DEFAULT_LEFT_RATIO, approveButtonTarget, approvePlanTarget } from '../../components/general/ChatWindow'
import { ChatTimeline } from '../../components/general/ChatTimeline'
import { SaasLandingMock } from '../../components/general/SaasLandingMock'
import { PublishModalMock, PUBLISH_MODAL_LAYOUT } from '../../components/general/PublishModalMock'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { Toast } from '../../components/Toast'
import { ZoomFocus } from '../../components/ZoomFocus'
import { BADGES, CAMERA, CUE, CURSORS, DEPLOY, PREVIEW } from '../../data/chatTimeline'
import { OVERLAY_TEXT } from '../../data/generalPromoScript'
import { PUBLISH_COPY } from '../../data/publishSteps'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const PREVIEW_W = CHAT_BODY.width - Math.round(CHAT_BODY.width * DEFAULT_LEFT_RATIO)
const DIVIDER_X = CHAT_BODY.left + Math.round(CHAT_BODY.width * DEFAULT_LEFT_RATIO)
const PLAN_T = approvePlanTarget(0.5)
const DIFF_T = approveButtonTarget(0.5)
const COPY_T = { x: 960 + PUBLISH_MODAL_LAYOUT.copyButtonOffset.x, y: 540 + PUBLISH_MODAL_LAYOUT.copyButtonOffset.y }
const CAM = CAMERA.map((k) => ({ frame: k.frame, scale: k.scale, x: k.x, y: k.y }))

const Badge: React.FC<{ start: number; end: number; text: string }> = ({ start, end, text }) => {
  const f = useCurrentFrame()
  const o = interpolate(f, [start, start + 8], [0, 1], CLAMP) * interpolate(f, [end, end + 10], [1, 0], CLAMP)
  if (o <= 0) return null
  const y = interpolate(f, [start, start + 8], [10, 0], CLAMP)
  return (
    <div
      style={{
        position: 'absolute',
        left: DIVIDER_X,
        right: 0,
        bottom: 120,
        display: 'flex',
        justifyContent: 'center',
        opacity: o,
        transform: `translateY(${y}px)`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(15,15,15,0.92)',
          border: `1px solid ${tokens.colors.accent.green}`,
          borderRadius: tokens.radius.pill,
          padding: '8px 16px',
          fontFamily: tokens.fontFamily.ui,
          fontSize: 17,
          fontWeight: 600,
          color: tokens.colors.text.primary,
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: 9999, background: tokens.colors.accent.greenBright }} />
        {text}
      </div>
    </div>
  )
}

export const SessionScene: React.FC = () => {
  const frame = useCurrentFrame()
  const cue = interpolate(frame, [CUE.start, CUE.start + 10, CUE.end - 10, CUE.end], [0, 1, 1, 0], CLAMP)
  const dotX = interpolate(frame, [CUE.start + 4, CUE.end - 6], [DIVIDER_X - 30, DIVIDER_X + PREVIEW_W * 0.5], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />
      <ZoomFocus width={1920} height={1080} keyframes={CAM}>
        <ChatWindow
          chat={<ChatTimeline />}
          preview={<SaasLandingMock width={PREVIEW_W} height={CHAT_BODY.height} revealFrame={PREVIEW.revealFrame} polishFrom={PREVIEW.polishFrom} />}
        />

        {/* Diff → preview connecting cue */}
        <div style={{ position: 'absolute', left: DIVIDER_X - 1.5, top: 80, width: 3, height: 920, background: tokens.gradient.accentPrimary, opacity: cue * 0.7, filter: 'blur(1px)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', left: dotX - 9, top: 540 - 9, width: 18, height: 18, borderRadius: 9, background: tokens.colors.accent.primary, opacity: cue, boxShadow: `0 0 24px 6px ${tokens.colors.accent.primaryGlow}`, pointerEvents: 'none' }} />

        {/* Deploy modal (light backdrop so the preview stays visible) */}
        <PublishModalMock startFrame={DEPLOY.start} perStepFrames={DEPLOY.perStep} liveFrame={DEPLOY.live} copyPressFrame={DEPLOY.copyPress} backdropOpacity={0.28} />

        {/* Cursors */}
        <AnimatedCursor appearFrame={CURSORS.plan.appear} disappearFrame={CURSORS.plan.click + 26} keyframes={[
          { frame: CURSORS.plan.appear, x: PLAN_T.x + 120, y: PLAN_T.y - 150 },
          { frame: CURSORS.plan.click - 2, x: PLAN_T.x, y: PLAN_T.y },
          { frame: CURSORS.plan.click, x: PLAN_T.x, y: PLAN_T.y, click: true },
          { frame: CURSORS.plan.click + 20, x: PLAN_T.x, y: PLAN_T.y },
        ]} />
        <AnimatedCursor appearFrame={CURSORS.diff.appear} disappearFrame={CURSORS.diff.click + 26} keyframes={[
          { frame: CURSORS.diff.appear, x: DIFF_T.x + 140, y: DIFF_T.y - 150 },
          { frame: CURSORS.diff.click - 2, x: DIFF_T.x, y: DIFF_T.y },
          { frame: CURSORS.diff.click, x: DIFF_T.x, y: DIFF_T.y, click: true },
          { frame: CURSORS.diff.click + 20, x: DIFF_T.x, y: DIFF_T.y },
        ]} />
        <AnimatedCursor appearFrame={CURSORS.copy.appear} disappearFrame={CURSORS.copy.click + 30} keyframes={[
          { frame: CURSORS.copy.appear, x: COPY_T.x - 70, y: COPY_T.y + 120 },
          { frame: CURSORS.copy.click - 2, x: COPY_T.x, y: COPY_T.y },
          { frame: CURSORS.copy.click, x: COPY_T.x, y: COPY_T.y, click: true },
          { frame: CURSORS.copy.click + 24, x: COPY_T.x, y: COPY_T.y },
        ]} />
      </ZoomFocus>

      {/* Screen-space overlays (unscaled) */}
      <Badge start={BADGES.preview.start} end={BADGES.preview.end} text={OVERLAY_TEXT.previewBadge} />
      <Badge start={BADGES.design.start} end={BADGES.design.end} text={OVERLAY_TEXT.designBadge} />
      <Toast text={PUBLISH_COPY.copied} startFrame={DEPLOY.toastStart} holdFrames={26} />
    </AbsoluteFill>
  )
}
