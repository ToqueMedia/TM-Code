// Story scene 3 — Plano (150f / 5s). Big plan card; items tick on; cursor
// clicks "Aprovar plano" → "✓ Plano aprovado" (green glow).

import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { TargetMark } from '../../components/general/debugTargets'
import { STORY_CAPTIONS, STORY_PLAN_ITEMS } from '../../data/storyVertical'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const CARD = { left: 70, top: 470, width: 940, pad: 36 }
const ITEM_H = 64
const BTN_H = 104
const itemsTop = CARD.top + CARD.pad + 56 + 30 // title block
const btnTop = itemsTop + STORY_PLAN_ITEMS.length * ITEM_H + 30
const BTN_T = { x: 540, y: btnTop + BTN_H / 2 }

export const StoryPlanScene: React.FC = () => {
  const frame = useCurrentFrame()
  // Visible immediately (slide settle only) so there is no empty frame at the cut.
  const enterY = interpolate(frame, [0, 8], [28, 0], CLAMP)
  const press = interpolate(frame, [112, 115, 118], [0, 1, 0], CLAMP)
  const approved = interpolate(frame, [122, 132], [0, 1], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />
      <div style={{ position: 'absolute', left: CARD.left, top: CARD.top, width: CARD.width, boxSizing: 'border-box', padding: CARD.pad, borderRadius: 22, background: tokens.colors.bg.card, border: `1px solid ${tokens.colors.border.glass}`, fontFamily: tokens.fontFamily.ui, transform: `translateY(${enterY}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 56 }}>
          <span style={{ color: tokens.colors.accent.purple, fontSize: 30 }}>◆</span>
          <span style={{ fontSize: 38, fontWeight: 800, color: tokens.colors.text.primary }}>Plano de implementação</span>
        </div>
        <div style={{ marginTop: 30 }}>
          {STORY_PLAN_ITEMS.map((item, i) => {
            const appear = 6 + i * 10
            const o = interpolate(frame, [appear, appear + 8], [0, 1], CLAMP)
            const tx = interpolate(frame, [appear, appear + 8], [-10, 0], CLAMP)
            return (
              <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 18, height: ITEM_H, opacity: o, transform: `translateX(${tx}px)` }}>
                <span style={{ width: 36, height: 36, borderRadius: 9999, background: tokens.colors.accent.greenSubtle, border: `1px solid ${tokens.colors.accent.green}`, color: tokens.colors.accent.greenBright, fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✓</span>
                <span style={{ fontSize: 36, color: tokens.colors.text.assistant }}>{item}</span>
              </div>
            )
          })}
        </div>
        <div style={{ position: 'relative', height: BTN_H, marginTop: 30, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36, fontWeight: 800, color: '#fff', overflow: 'hidden', transform: `scale(${1 - 0.03 * press})`, filter: `brightness(${1 + 0.2 * press})`, boxShadow: `0 0 ${40 * approved}px rgba(46,160,67,${0.6 * approved})` }}>
          <span style={{ position: 'absolute', inset: 0, background: tokens.gradient.accentPrimary, opacity: 1 - approved }} aria-hidden />
          <span style={{ position: 'absolute', inset: 0, background: tokens.colors.accent.greenSubtle, border: `1px solid ${tokens.colors.accent.green}`, boxSizing: 'border-box', opacity: approved }} aria-hidden />
          <span style={{ position: 'relative', color: approved > 0.5 ? tokens.colors.accent.greenBright : '#fff' }}>{approved > 0.5 ? '✓ Plano aprovado' : 'Aprovar plano'}</span>
        </div>
      </div>

      <AnimatedCursor appearFrame={82} disappearFrame={140} keyframes={[
        { frame: 82, x: BTN_T.x + 140, y: BTN_T.y + 170 },
        { frame: 104, x: BTN_T.x, y: BTN_T.y },
        { frame: 112, x: BTN_T.x, y: BTN_T.y, click: true },
        { frame: 134, x: BTN_T.x, y: BTN_T.y },
      ]} />
      <TargetMark x={BTN_T.x} y={BTN_T.y} w={CARD.width - 2 * CARD.pad} h={BTN_H} />
      <Caption text={STORY_CAPTIONS.plan} startFrame={14} endFrame={140} position="top" size={58} inset={140} />
    </AbsoluteFill>
  )
}
