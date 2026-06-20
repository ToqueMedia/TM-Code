// Plan approval card shown in the chat (scene "plan"). A "Plano de implementação"
// checklist that ticks off item by item, then a full-width "Aprovar plano"
// button the user clicks. Full-width button so the cursor target is the chat
// column center-bottom (see ChatWindow.approvePlanTarget).

import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'
import { PLAN_ITEMS } from '../../data/generalPromoScript'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export interface PlanApprovalMockProps {
  startFrame: number
  approvePressFrame?: number
  approvedFrame?: number
  width?: number
}

export const PlanApprovalMock: React.FC<PlanApprovalMockProps> = ({
  startFrame,
  approvePressFrame,
  approvedFrame,
  width,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const enter = spring({ frame: frame - startFrame, fps, config: { damping: 18 } })
  const fadeIn = interpolate(frame, [startFrame, startFrame + 10], [0, 1], CLAMP)
  const rise = interpolate(enter, [0, 1], [12, 0], CLAMP)

  let pressT = 0
  if (approvePressFrame !== undefined) {
    pressT = interpolate(frame, [approvePressFrame, approvePressFrame + 3, approvePressFrame + 6], [0, 1, 0], CLAMP)
  }
  const approvedT = approvedFrame !== undefined ? interpolate(frame, [approvedFrame, approvedFrame + 8], [0, 1], CLAMP) : 0

  return (
    <div
      style={{
        width: width ?? '100%',
        boxSizing: 'border-box',
        background: tokens.colors.bg.card,
        border: `1px solid ${tokens.colors.border.glass}`,
        borderRadius: 12,
        padding: '18px 20px',
        fontFamily: tokens.fontFamily.ui,
        opacity: fadeIn,
        transform: `translateY(${rise}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ color: tokens.colors.accent.purple, fontSize: 18 }}>◆</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.text.primary }}>
          Plano de implementação
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {PLAN_ITEMS.map((item, i) => {
          const appear = startFrame + 12 + i * 8
          const o = interpolate(frame, [appear, appear + 6], [0, 1], CLAMP)
          const tx = interpolate(frame, [appear, appear + 6], [-8, 0], CLAMP)
          return (
            <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: o, transform: `translateX(${tx}px)` }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: tokens.radius.pill,
                  background: tokens.colors.accent.greenSubtle,
                  border: `1px solid ${tokens.colors.accent.green}`,
                  color: tokens.colors.accent.greenBright,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                ✓
              </span>
              <span style={{ fontSize: 18, color: tokens.colors.text.assistant }}>{item}</span>
            </div>
          )
        })}
      </div>

      {/* Full-width "Aprovar plano" button */}
      <div
        style={{
          position: 'relative',
          height: 52,
          marginTop: 18,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 17,
          fontWeight: 700,
          color: '#ffffff',
          transform: `scale(${1 - 0.04 * pressT})`,
          filter: `brightness(${1 + 0.22 * pressT})`,
          boxShadow: `0 0 ${32 * approvedT}px rgba(46,160,67,${0.55 * approvedT})`,
          overflow: 'hidden',
        }}
      >
        <span style={{ position: 'absolute', inset: 0, background: tokens.gradient.accentPrimary, opacity: 1 - approvedT, borderRadius: 10 }} aria-hidden />
        <span style={{ position: 'absolute', inset: 0, background: tokens.colors.accent.greenSubtle, border: `1px solid ${tokens.colors.accent.green}`, boxSizing: 'border-box', opacity: approvedT, borderRadius: 10 }} aria-hidden />
        <span style={{ position: 'relative', color: approvedT > 0.5 ? tokens.colors.accent.greenBright : '#ffffff' }}>
          {approvedT > 0.5 ? '✓ Plano aprovado' : 'Aprovar plano'}
        </span>
      </div>
    </div>
  )
}
