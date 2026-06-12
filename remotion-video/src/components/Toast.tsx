import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'

export interface ToastProps {
  text: string
  /** Frame (local to the enclosing Sequence) at which the toast slides in. */
  startFrame: number
  /** How long the toast stays fully visible before sliding out (default 60). */
  holdFrames?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/**
 * Success toast (bottom-right). Slides up + fades in, holds, then fades +
 * slides down. Renders null when fully invisible.
 */
export const Toast: React.FC<ToastProps> = ({ text, startFrame, holdFrames = 60 }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const exitStart = startFrame + holdFrames
  if (frame < startFrame || frame >= exitStart + 10) return null

  // Enter: slide up 24px (spring, no overshoot) + fade over 10 frames.
  const enter = spring({ frame: frame - startFrame, fps, config: { damping: 200 } })
  const enterY = 24 * (1 - enter)
  const fadeIn = interpolate(frame, [startFrame, startFrame + 10], [0, 1], CLAMP)

  // Exit: fade + slide down 12px over 10 frames.
  const fadeOut = interpolate(frame, [exitStart, exitStart + 10], [1, 0], CLAMP)
  const exitY = interpolate(frame, [exitStart, exitStart + 10], [0, 12], CLAMP)

  const opacity = fadeIn * fadeOut
  if (opacity <= 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 28,
        right: 28,
        background: '#141414',
        border: '1px solid rgba(255,255,255,0.08)',
        borderLeft: `3px solid ${tokens.colors.accent.green}`,
        borderRadius: 10,
        padding: '15px 20px',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        maxWidth: 520,
        opacity,
        transform: `translateY(${enterY + exitY}px)`,
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 9999,
          background: tokens.colors.accent.greenSubtle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.colors.terminal.brightGreen,
          fontWeight: 700,
          fontSize: 16,
          flexShrink: 0,
          fontFamily: tokens.fontFamily.ui,
        }}
      >
        ✓
      </span>
      <span
        style={{
          fontSize: 17,
          color: tokens.colors.text.primary,
          fontFamily: tokens.fontFamily.ui,
          lineHeight: 1.4,
        }}
      >
        {text}
      </span>
    </div>
  )
}
