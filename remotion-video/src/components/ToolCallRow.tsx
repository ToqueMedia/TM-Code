import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'
import type { ToolCallSpec } from '../data/agentScript'

export interface ToolCallRowProps {
  spec: ToolCallSpec
  /**
   * Frame (local to the enclosing Sequence) at which the row appears.
   * Negative values are valid: the row renders fully entered from frame 0
   * (used for pre-existing history).
   */
  startFrame: number
  /** Frame at which the call flips from running to done. Negative = already done. */
  doneFrame: number
  /** When true, the done marker uses the failed color. */
  isError?: boolean
}

/**
 * A tool-call row exactly like the real TM Code terminal:
 * `⟳ Reading(server/routes/users.ts)` while running, `● Read(...)` + summary
 * when done. All motion is frame-driven.
 */
export const ToolCallRow: React.FC<ToolCallRowProps> = ({ spec, startFrame, doneFrame, isError = false }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  if (frame < startFrame) return null

  const enterOpacity = interpolate(frame, [startFrame, startFrame + 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const enterRise = interpolate(frame, [startFrame, startFrame + 6], [8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  const isRunning = frame < doneFrame

  let marker: React.ReactNode
  if (isRunning) {
    marker = (
      <span
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: tokens.colors.toolCall.runningText,
          display: 'inline-block',
          transform: `rotate(${((frame - startFrame) * 24) % 360}deg)`,
        }}
      >
        ⟳
      </span>
    )
  } else {
    // Small pop at doneFrame (frame - doneFrame >= 0 here, also for negative doneFrame).
    const pop = spring({
      frame: frame - doneFrame,
      fps,
      config: { damping: 12 },
      durationInFrames: 8,
    })
    marker = (
      <span
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: isError ? tokens.colors.toolCall.failedText : tokens.colors.toolCall.doneText,
          display: 'inline-block',
          transform: `scale(${0.6 + 0.4 * pop})`,
        }}
      >
        ●
      </span>
    )
  }

  const summaryOpacity = interpolate(frame, [doneFrame + 2, doneFrame + 7], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const summaryIsCheck = spec.summary !== undefined && spec.summary.startsWith('✓')

  return (
    <div
      style={{
        fontFamily: tokens.fontFamily.mono,
        opacity: enterOpacity,
        transform: `translateY(${enterRise}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {marker}
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: tokens.colors.terminal.foreground,
          }}
        >
          {isRunning ? spec.verbRunning : spec.verbDone}
          <span style={{ color: tokens.colors.text.muted, fontWeight: 400 }}>
            {'(' + spec.subtitle + ')'}
          </span>
        </span>
      </div>
      <div
        style={{
          marginLeft: 10,
          borderLeft: '2px solid ' + tokens.colors.toolCall.bodyRail,
          paddingLeft: 18,
          marginTop: 4,
          minHeight: 24,
        }}
      >
        {isRunning ? (
          <span style={{ fontSize: 18, color: tokens.colors.toolCall.runningText, opacity: 0.8 }}>
            working…
          </span>
        ) : spec.summary !== undefined ? (
          <span
            style={{
              fontSize: 18,
              color: summaryIsCheck ? tokens.colors.terminal.brightGreen : tokens.colors.text.disabled,
              fontWeight: summaryIsCheck ? 600 : 400,
              opacity: summaryOpacity,
            }}
          >
            {spec.summary}
          </span>
        ) : null}
      </div>
    </div>
  )
}
