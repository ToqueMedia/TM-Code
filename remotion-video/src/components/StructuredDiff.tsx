import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import type { DiffSpec } from '../data/diffData'

export interface StructuredDiffProps {
  diff: DiffSpec
  /** Frame (local to the enclosing Sequence) at which the summary line fades in. */
  startFrame: number
  /** Frames between consecutive row reveals (default 3). */
  framesPerLine?: number
  /** Code font size in px (default 19). Gutter renders at fontSize - 2, hunk at fontSize - 3. */
  fontSize?: number
  /** Indices into diff.lines to emphasize between highlightStartFrame and highlightEndFrame. */
  highlightLines?: readonly number[]
  /** Frame at which the highlight state fades in (over 6 frames). */
  highlightStartFrame?: number
  /** Frame at which the highlight state starts fading out (over 6 frames). */
  highlightEndFrame?: number
  /** Emphasis rail color for highlighted rows (default brand pink). */
  highlightColor?: string
  /** Emphasis row tint for highlighted rows (default translucent pink). */
  highlightTint?: string
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/**
 * Faithful replica of the real TM Code structured diff renderer (hunk header
 * rows, line-number gutter, +/− marker column, add/remove tinted rows).
 * Rows reveal progressively so the box grows downward — all frame-driven.
 */
export const StructuredDiff: React.FC<StructuredDiffProps> = ({
  diff,
  startFrame,
  framesPerLine = 3,
  fontSize = 19,
  highlightLines,
  highlightStartFrame,
  highlightEndFrame,
  highlightColor = tokens.colors.accent.primary,
  highlightTint = 'rgba(254,16,99,0.10)',
}) => {
  const frame = useCurrentFrame()

  const summaryOpacity = interpolate(frame, [startFrame, startFrame + 5], [0, 1], CLAMP)

  // Highlight state strength 0..1 — fades in over 6 frames at highlightStartFrame
  // and back out over 6 frames after highlightEndFrame. 0 when props are absent.
  let highlightStrength = 0
  if (
    highlightLines !== undefined &&
    highlightLines.length > 0 &&
    highlightStartFrame !== undefined &&
    highlightEndFrame !== undefined
  ) {
    highlightStrength =
      interpolate(frame, [highlightStartFrame, highlightStartFrame + 6], [0, 1], CLAMP) *
      interpolate(frame, [highlightEndFrame, highlightEndFrame + 6], [1, 0], CLAMP)
  }
  const highlightSet = new Set<number>(highlightLines ?? [])

  // The box only exists once the first row starts revealing, so it never shows
  // as an empty bordered sliver before content arrives.
  const firstRowFrame = startFrame + 6
  const showBox = frame >= firstRowFrame

  return (
    <div style={{ fontFamily: tokens.fontFamily.mono }}>
      {/* Summary line: └ Added N lines */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          fontSize: 18,
          opacity: summaryOpacity,
        }}
      >
        <span style={{ color: tokens.colors.text.disabled }}>{'└'}</span>
        <span style={{ color: tokens.colors.text.secondary }}>{diff.summary}</span>
      </div>

      {showBox ? (
        <div
          style={{
            marginTop: 8,
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.015)',
            overflow: 'hidden',
            lineHeight: 1.65,
          }}
        >
          {diff.lines.map((line, i) => {
            const appear = startFrame + 6 + i * framesPerLine
            // Not yet revealed: render nothing so the box grows downward.
            if (frame < appear) return null

            const enter = interpolate(frame, [appear, appear + 4], [0, 1], CLAMP)
            const tx = interpolate(frame, [appear, appear + 4], [-8, 0], CLAMP)

            const isHighlighted = highlightSet.has(i)
            // Non-highlighted rows dim to 0.45 while the highlight state is active.
            const dim = !isHighlighted ? 1 - 0.55 * highlightStrength : 1

            const highlightOverlay =
              isHighlighted && highlightStrength > 0 ? (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: highlightTint,
                    boxShadow: `inset 3px 0 0 ${highlightColor}`,
                    opacity: highlightStrength,
                    pointerEvents: 'none',
                  }}
                />
              ) : null

            if (line.kind === 'hunk') {
              return (
                <div
                  key={i}
                  style={{
                    position: 'relative',
                    padding: '5px 14px',
                    background: tokens.colors.diff.hunkBg,
                    color: tokens.colors.diff.hunkText,
                    fontSize: fontSize - 3,
                    letterSpacing: '0.02em',
                    opacity: 0.9 * enter * dim,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    transform: `translateX(${tx}px)`,
                  }}
                >
                  {line.text}
                  {highlightOverlay}
                </div>
              )
            }

            const rowBg =
              line.kind === 'add'
                ? tokens.colors.diff.addedBg
                : line.kind === 'remove'
                  ? tokens.colors.diff.removedBg
                  : 'transparent'
            const rowColor =
              line.kind === 'add'
                ? tokens.colors.diff.addedText
                : line.kind === 'remove'
                  ? tokens.colors.diff.removedText
                  : tokens.colors.text.secondary
            const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''

            return (
              <div
                key={i}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'stretch',
                  background: rowBg,
                  color: rowColor,
                  fontSize,
                  opacity: enter * dim,
                  transform: `translateX(${tx}px)`,
                }}
              >
                {highlightOverlay}
                <span
                  style={{
                    width: 64,
                    textAlign: 'right',
                    paddingRight: 14,
                    color: tokens.colors.diff.lineNumber,
                    opacity: 0.6,
                    fontSize: fontSize - 2,
                  }}
                >
                  {line.lineNo ?? ''}
                </span>
                <span style={{ width: '2ch', textAlign: 'center', fontWeight: 700 }}>{marker}</span>
                <span style={{ flex: 1, whiteSpace: 'pre', paddingRight: 14 }}>{line.text}</span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
