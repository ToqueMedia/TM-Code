// Story scene 6 — Deploy (210f / 7s). Big simplified publish modal (3 steps) +
// large URL. The "Copiar URL" button has a DETERMINISTIC position so the cursor
// lands exactly on it; the "✓ URL copiada" state only fires after the press.
// Premium preview stays clearly visible behind (light dim).

import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { MacWindowFrame, TITLEBAR_HEIGHT } from '../../components/MacWindowFrame'
import { SaasLandingMock } from '../../components/general/SaasLandingMock'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { TargetMark } from '../../components/general/debugTargets'
import { STORY_CAPTIONS, STORY_STEPS } from '../../data/storyVertical'
import { DEPLOY_URL, PUBLISH_COPY } from '../../data/publishSteps'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const PW = { x: 40, y: 300, width: 1000, height: 1440 }

// Deterministic modal layout so the copy button's centre is exact.
const M = { left: 80, top: 540, width: 920, pad: 44 }
const TITLE_H = 56, STEP_H = 52, STEP_GAP = 18, STEPS_MT = 28, URL_H = 92, URL_MT = 36, BTN_MT = 24, BTN_H = 100
const stepsTop = M.top + M.pad + TITLE_H + STEPS_MT
const stepsH = STORY_STEPS.length * STEP_H + (STORY_STEPS.length - 1) * STEP_GAP
const urlTop = stepsTop + stepsH + URL_MT
const btnTop = urlTop + URL_H + BTN_MT
const COPY_T = { x: 540, y: btnTop + BTN_H / 2 }
const CLICK = 152

export const StoryDeployScene: React.FC = () => {
  const frame = useCurrentFrame()
  const modal = interpolate(frame, [6, 16], [0, 1], CLAMP)
  const urlIn = interpolate(frame, [92, 106], [0, 1], CLAMP)
  const press = interpolate(frame, [CLICK, CLICK + 3, CLICK + 6], [0, 1, 0], CLAMP)
  const copied = interpolate(frame, [CLICK + 6, CLICK + 16], [0, 1], CLAMP) // only after the click

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />
      {/* Premium preview behind — clearly visible (light dim ≈ 0.3) */}
      <AbsoluteFill style={{ opacity: 0.7 }}>
        <div style={{ position: 'absolute', left: PW.x, top: PW.y }}>
          <MacWindowFrame title="TM Code" subtitle="preview" width={PW.width} height={PW.height}>
            <SaasLandingMock width={PW.width - 2} height={PW.height - TITLEBAR_HEIGHT - 2} revealFrame={-20} polish={1} />
          </MacWindowFrame>
        </div>
      </AbsoluteFill>

      {/* Big modal */}
      <div style={{ position: 'absolute', left: M.left, top: M.top, width: M.width, boxSizing: 'border-box', padding: M.pad, borderRadius: 24, background: tokens.colors.dialog.bg, border: `1px solid ${tokens.colors.dialog.border}`, boxShadow: '0 30px 90px rgba(0,0,0,0.6)', fontFamily: tokens.fontFamily.ui, opacity: modal }}>
        <div style={{ height: TITLE_H, display: 'flex', alignItems: 'center', fontSize: 44, fontWeight: 800, color: tokens.colors.text.primary }}>Publicar projecto</div>
        <div style={{ marginTop: STEPS_MT, display: 'flex', flexDirection: 'column', gap: STEP_GAP }}>
          {STORY_STEPS.map((s, i) => {
            const done = frame >= 16 + i * 24
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 18, height: STEP_H, fontSize: 36, opacity: frame >= 10 + i * 24 ? 1 : 0.3 }}>
                <span style={{ width: 40, height: 40, borderRadius: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: done ? tokens.colors.accent.greenBright : tokens.colors.toolCall.runningText, background: done ? tokens.colors.accent.greenSubtle : 'transparent', border: done ? `1px solid ${tokens.colors.accent.green}` : `1px solid ${tokens.colors.toolCall.runningText}` }}>{done ? '✓' : '·'}</span>
                <span style={{ color: done ? tokens.colors.text.primary : tokens.colors.text.secondary, fontWeight: done ? 700 : 400 }}>{s}</span>
              </div>
            )
          })}
        </div>
        {/* Big URL */}
        <div style={{ marginTop: URL_MT, height: URL_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', padding: '0 26px', borderRadius: 14, background: tokens.colors.bg.input, border: `1px solid ${tokens.colors.accent.greenSubtle}`, boxShadow: `0 0 30px ${tokens.colors.accent.greenSubtle}`, fontFamily: tokens.fontFamily.mono, fontSize: 33, color: tokens.colors.text.primary, opacity: urlIn, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {DEPLOY_URL.replace('https://', '')}
        </div>
        {/* Copy button — flips to "✓ URL copiada" only after the press */}
        <div style={{ position: 'relative', marginTop: BTN_MT, height: BTN_H, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 36, fontWeight: 800, opacity: urlIn, overflow: 'hidden', transform: `scale(${1 - 0.03 * press})`, filter: `brightness(${1 + 0.2 * press})`, boxShadow: `0 14px 40px rgba(254,16,99,${0.5 * (1 - copied)})` }}>
          <span style={{ position: 'absolute', inset: 0, background: tokens.gradient.accentPrimary, opacity: 1 - copied }} aria-hidden />
          <span style={{ position: 'absolute', inset: 0, background: tokens.colors.accent.greenSubtle, border: `1px solid ${tokens.colors.accent.green}`, boxSizing: 'border-box', opacity: copied }} aria-hidden />
          <span style={{ position: 'relative', color: copied > 0.5 ? tokens.colors.accent.greenBright : '#fff' }}>{copied > 0.5 ? '✓ ' + PUBLISH_COPY.copied : 'Copiar URL'}</span>
        </div>
      </div>

      <AnimatedCursor appearFrame={120} disappearFrame={196} keyframes={[
        { frame: 120, x: COPY_T.x + 140, y: COPY_T.y + 170 },
        { frame: 144, x: COPY_T.x, y: COPY_T.y },
        { frame: CLICK, x: COPY_T.x, y: COPY_T.y, click: true },
        { frame: 184, x: COPY_T.x, y: COPY_T.y },
      ]} />
      <TargetMark x={COPY_T.x} y={COPY_T.y} w={M.width - 2 * M.pad} h={BTN_H} />
      <Caption text={STORY_CAPTIONS.deploy} startFrame={14} endFrame={118} position="top" size={58} inset={140} />
    </AbsoluteFill>
  )
}
