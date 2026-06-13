import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { STATUS_LABELS } from '../data/mockUsers'

export interface StatusBadgeProps {
  initial: 'locked' | 'available'
  lockedText?: string
  availableText?: string
  /** Frame (local to the enclosing Sequence) at which the badge crossfades to the available look. */
  switchFrame?: number
  fontSize?: number
}

interface BadgeLook {
  color: string
  background: string
  border: string
  dot: string
}

const LOOKS: Record<'locked' | 'available', BadgeLook> = {
  locked: {
    color: tokens.colors.accent.red,
    background: tokens.colors.accent.redSubtle,
    border: '1px solid rgba(248,81,73,0.35)',
    dot: tokens.colors.accent.red,
  },
  available: {
    color: tokens.colors.accent.greenBright,
    background: tokens.colors.accent.greenSubtle,
    border: '1px solid rgba(46,160,67,0.35)',
    dot: tokens.colors.accent.greenBright,
  },
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const pillStyle = (look: BadgeLook, fontSize: number): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 16px',
  borderRadius: 9999,
  fontWeight: 600,
  fontFamily: tokens.fontFamily.ui,
  whiteSpace: 'nowrap',
  fontSize,
  // lineHeight 1.25 → 20px at the default 16px (keeps the pill 7+20+7 = 34px tall,
  // which ADMIN_LAYOUT in AdminUserManagementMock relies on).
  lineHeight: 1.25,
  color: look.color,
  background: look.background,
  border: look.border,
})

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: 9999,
      background: color,
      flexShrink: 0,
    }}
  />
)

/**
 * Status pill of the Katondo Queue demo app. When `switchFrame` is set it
 * crossfades from the initial look/text to the "available" look/text over
 * 12 frames with a small scale pop (1 → 1.06 → 1). Frame-driven only.
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({
  initial,
  lockedText = STATUS_LABELS.locked,
  availableText = STATUS_LABELS.available,
  switchFrame,
  fontSize = 16,
}) => {
  const frame = useCurrentFrame()

  const textFor = (look: 'locked' | 'available') => (look === 'locked' ? lockedText : availableText)

  // Crossfade progress 0 → 1 over 12 frames from switchFrame.
  const t =
    switchFrame !== undefined
      ? interpolate(frame, [switchFrame, switchFrame + 12], [0, 1], CLAMP)
      : 0

  // Small pop: 1 -> 1.06 -> 1 across the 12-frame crossfade.
  const pop =
    switchFrame !== undefined
      ? interpolate(frame, [switchFrame, switchFrame + 6, switchFrame + 12], [1, 1.06, 1], CLAMP)
      : 1

  const fromLook = LOOKS[initial]
  const toLook = LOOKS.available

  if (t <= 0) {
    return (
      <span style={{ ...pillStyle(fromLook, fontSize), transform: `scale(${pop})` }}>
        <Dot color={fromLook.dot} />
        {textFor(initial)}
      </span>
    )
  }

  if (t >= 1) {
    return (
      <span style={{ ...pillStyle(toLook, fontSize), transform: `scale(${pop})` }}>
        <Dot color={toLook.dot} />
        {textFor('available')}
      </span>
    )
  }

  // Mid-crossfade: stack both pills (target absolutely positioned on top).
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        transform: `scale(${pop})`,
      }}
    >
      <span style={{ ...pillStyle(fromLook, fontSize), opacity: 1 - t }}>
        <Dot color={fromLook.dot} />
        {textFor(initial)}
      </span>
      <span
        style={{
          ...pillStyle(toLook, fontSize),
          opacity: t,
          position: 'absolute',
          left: 0,
          top: 0,
        }}
      >
        <Dot color={toLook.dot} />
        {textFor('available')}
      </span>
    </span>
  )
}
