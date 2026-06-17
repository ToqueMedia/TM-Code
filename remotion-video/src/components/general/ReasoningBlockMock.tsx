// Reasoning ("A pensar") block exactly like the real TM Code chat: while the
// agent thinks, the label runs a travelling purple shimmer with three pulsing
// dots; once thinking is done the label collapses to `A pensar · 2.3s` with a
// small triangle marker and the reasoning lines reveal one by one. All motion is
// frame-driven (no CSS transitions, no Math.random/Date).

import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { REASONING } from '../../data/generalPromoScript'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export interface ReasoningBlockMockProps {
  startFrame: number
  activeUntilFrame: number
  label?: string
  durationText?: string
  lines?: readonly string[]
  width?: number | string
}

// Length of the shimmer loop, in frames.
const SHIMMER_PERIOD = 54

export const ReasoningBlockMock: React.FC<ReasoningBlockMockProps> = ({
  startFrame,
  activeUntilFrame,
  label = REASONING.label,
  durationText = REASONING.duration,
  lines = REASONING.lines,
  width = '100%',
}) => {
  const frame = useCurrentFrame()

  if (frame < startFrame) return null

  const enterOpacity = interpolate(frame, [startFrame, startFrame + 6], [0, 1], CLAMP)

  const isThinking = frame < activeUntilFrame

  // Travelling shimmer: backgroundPositionX moves from 200% -> -200% across the
  // repeating window so the bright band sweeps across the label text.
  const shimmerProgress = (frame % SHIMMER_PERIOD) / SHIMMER_PERIOD
  const shimmerX = interpolate(shimmerProgress, [0, 1], [200, -200], CLAMP)

  return (
    <div
      style={{
        width,
        boxSizing: 'border-box',
        background: tokens.colors.bg.card,
        border: `1px solid ${tokens.colors.border.glass}`,
        borderLeft: `3px solid ${tokens.colors.accent.purple}`,
        borderRadius: 10,
        padding: '12px 16px',
        opacity: enterOpacity,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      {/* Header */}
      {isThinking ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontSize: 18,
              fontWeight: 600,
              backgroundImage:
                'linear-gradient(90deg, rgba(163,113,247,0.4) 25%, rgba(163,113,247,1) 50%, rgba(163,113,247,0.4) 75%)',
              backgroundSize: '200% 100%',
              backgroundPositionX: `${shimmerX}%`,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {label}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {[0, 1, 2].map((i) => {
              const dotOpacity = interpolate(
                (frame + i * 8) % 24,
                [0, 12, 24],
                [0.3, 1, 0.3],
                CLAMP,
              )
              return (
                <span
                  key={i}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 9999,
                    background: tokens.colors.accent.purple,
                    opacity: dotOpacity,
                  }}
                />
              )
            })}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              display: 'inline-block',
              width: 0,
              height: 0,
              borderLeft: `5px solid ${tokens.colors.text.muted}`,
              borderTop: '4px solid transparent',
              borderBottom: '4px solid transparent',
              transform: 'rotate(90deg)',
            }}
          />
          <span style={{ fontSize: 16, fontWeight: 500, color: tokens.colors.text.muted }}>
            {label + ' · ' + durationText}
          </span>
        </div>
      )}

      {/* Body — reasoning lines reveal one by one after thinking ends */}
      {!isThinking ? (
        <div style={{ marginTop: 10 }}>
          {lines.map((line, i) => {
            const lineStart = activeUntilFrame + 4 + i * 7
            const lineOpacity = interpolate(frame, [lineStart, lineStart + 6], [0, 1], CLAMP)
            const lineRise = interpolate(frame, [lineStart, lineStart + 6], [8, 0], CLAMP)
            return (
              <div
                key={i}
                style={{
                  fontSize: 18,
                  color: tokens.colors.text.muted,
                  lineHeight: 1.7,
                  opacity: lineOpacity,
                  transform: `translateY(${lineRise}px)`,
                }}
              >
                {line}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
