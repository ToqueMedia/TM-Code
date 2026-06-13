import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'

interface HighlightBoxProps {
  x: number
  y: number
  width: number
  height: number
  /** Frame (local to the enclosing Sequence) at which the box draws in. */
  startFrame: number
  /** Frame at which it fades out. Omit to keep it visible. */
  endFrame?: number
  /** Optional tiny label above the box (mono, pink). */
  label?: string
  /** Border radius (default 8). */
  radius?: number
}

/**
 * TM Code-pink attention box with a soft glow. Draws in with a small spring
 * settle, fades out over 10 frames after endFrame.
 */
export const HighlightBox: React.FC<HighlightBoxProps> = ({
  x,
  y,
  width,
  height,
  startFrame,
  endFrame,
  label,
  radius = 8,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const enter = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 16, stiffness: 160, mass: 0.6 },
  })
  let opacity = interpolate(frame, [startFrame, startFrame + 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  if (endFrame !== undefined) {
    opacity *= interpolate(frame, [endFrame, endFrame + 10], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  }
  if (opacity <= 0) return null

  const scale = interpolate(enter, [0, 1], [1.08, 1])

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        borderRadius: radius,
        border: `2.5px solid ${tokens.colors.accent.primary}`,
        boxShadow: tokens.shadow.highlight,
        opacity,
        transform: `scale(${scale})`,
        pointerEvents: 'none',
      }}
    >
      {label ? (
        <div
          style={{
            position: 'absolute',
            top: -30,
            left: 0,
            fontFamily: tokens.fontFamily.mono,
            fontSize: 16,
            fontWeight: 700,
            color: tokens.colors.accent.primary,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  )
}
