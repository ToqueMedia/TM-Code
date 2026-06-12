import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'

export interface ThinkingDotsProps {
  /** Frame (local to the enclosing Sequence) at which the row fades in. */
  startFrame?: number
  /** Frame after which the row fades out over 8 frames. Omit to keep it visible. */
  endFrame?: number
}

const DOT_INDICES = [0, 1, 2] as const

/**
 * Three pulsing purple dots — the agent "thinking" indicator. The pulse is a
 * squared half-sine wave travelling across the dots (fully deterministic).
 */
export const ThinkingDots: React.FC<ThinkingDotsProps> = ({ startFrame = 0, endFrame }) => {
  const frame = useCurrentFrame()

  let rowOpacity = interpolate(frame, [startFrame, startFrame + 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  if (endFrame !== undefined) {
    rowOpacity *= interpolate(frame, [endFrame, endFrame + 8], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  }
  if (rowOpacity <= 0) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 4px',
        opacity: rowOpacity,
      }}
    >
      {DOT_INDICES.map((i) => {
        const p = Math.pow(Math.max(0, Math.sin((frame * 2 * Math.PI) / 42 - i * 0.9)), 2)
        return (
          <div
            key={i}
            style={{
              width: 9,
              height: 9,
              borderRadius: tokens.radius.pill,
              background: tokens.colors.accent.purple,
              opacity: 0.15 + 0.85 * p,
              transform: `scale(${0.7 + 0.3 * p})`,
            }}
          />
        )
      })}
    </div>
  )
}
