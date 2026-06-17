// Approve / Reject button row for a tool/diff approval in the chat. Buttons have
// FIXED widths so the cursor target is deterministic for any label. The Approve
// button keeps the same box across default → pressed → approved so the target
// never moves.

import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const APPROVE_W = 230
const REJECT_W = 130

export interface ApprovalButtonsMockProps {
  startFrame: number
  approvePressFrame?: number
  approvedFrame?: number
  width?: number
  approveLabel?: string
  rejectLabel?: string
  approvedLabel?: string
}

// Approve button is the right-most, fixed width APPROVE_W, right-aligned.
// Its center = container right − APPROVE_W/2. Row height 64 → centerY 32.
export const APPROVAL_LAYOUT: { approveFromRight: number; centerY: number } = {
  approveFromRight: APPROVE_W / 2,
  centerY: 32,
}

export const ApprovalButtonsMock: React.FC<ApprovalButtonsMockProps> = ({
  startFrame,
  approvePressFrame,
  approvedFrame,
  width,
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
  approvedLabel = 'Approved',
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const enter = spring({ frame: frame - startFrame, fps, config: { damping: 18 } })
  const fadeIn = interpolate(frame, [startFrame, startFrame + 12], [0, 1], CLAMP)
  const rise = interpolate(enter, [0, 1], [10, 0], CLAMP)

  let pressT = 0
  if (approvePressFrame !== undefined) {
    pressT = interpolate(frame, [approvePressFrame, approvePressFrame + 3, approvePressFrame + 6], [0, 1, 0], CLAMP)
  }
  const approvedT = approvedFrame !== undefined ? interpolate(frame, [approvedFrame, approvedFrame + 8], [0, 1], CLAMP) : 0

  const btnBase: React.CSSProperties = {
    height: 44,
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    fontSize: 16,
    whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        width: width ?? '100%',
        height: 64,
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 12,
        fontFamily: tokens.fontFamily.ui,
        opacity: fadeIn,
        transform: `translateY(${rise}px)`,
      }}
    >
      <span style={{ ...btnBase, width: REJECT_W, border: '1px solid rgba(255,255,255,0.14)', color: tokens.colors.text.secondary }}>
        {rejectLabel}
      </span>

      <span
        style={{
          ...btnBase,
          position: 'relative',
          width: APPROVE_W,
          fontWeight: 600,
          transform: `scale(${1 - 0.06 * pressT})`,
          filter: `brightness(${1 + 0.25 * pressT})`,
          overflow: 'hidden',
        }}
      >
        <span style={{ position: 'absolute', inset: 0, borderRadius: 8, background: tokens.gradient.accentPrimary, boxShadow: tokens.shadow.dialogButton, opacity: 1 - approvedT }} aria-hidden />
        <span style={{ position: 'absolute', inset: 0, borderRadius: 8, background: tokens.colors.accent.greenSubtle, border: '1px solid rgba(46,160,67,0.4)', boxSizing: 'border-box', opacity: approvedT }} aria-hidden />
        <span style={{ position: 'relative', color: approvedT > 0.5 ? tokens.colors.accent.greenBright : '#ffffff' }}>
          {approvedT > 0.5 ? '✓ ' + approvedLabel : approveLabel}
        </span>
      </span>
    </div>
  )
}
