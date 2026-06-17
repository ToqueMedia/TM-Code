import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'
import { GENERAL_TEST } from '../../data/generalPromoScript'

export interface GeneralTestOutputProps {
  /** Frame (local to the enclosing Sequence) at which the command starts typing. */
  startFrame: number
  /** Command typed at the top of the terminal run. */
  command?: string
  /** Check lines that appear one by one with green checkmarks. */
  checks?: readonly string[]
  /** Bold green summary that pops in after the last check. */
  summary?: string
  /** Prompt glyph before the command (default "$ "). */
  prefix?: string
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/** Chars revealed per frame for the typed test command. */
const TYPE_SPEED = 1.6

/**
 * Project-agnostic terminal test run: typed command, ✓ checks appearing one by
 * one, and a bold green summary with a playful spring pop. All frame-driven.
 * Mirrors components/TestRunnerOutput.tsx but sources its data from props.
 */
export const GeneralTestOutput: React.FC<GeneralTestOutputProps> = ({
  startFrame,
  command = GENERAL_TEST.command,
  checks = GENERAL_TEST.checks,
  summary = GENERAL_TEST.summary,
  prefix = '$ ',
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Line 1: "$ npm test" typed at 1.6 chars/frame.
  const typedChars = Math.max(
    0,
    Math.min(command.length, Math.floor((frame - startFrame) * TYPE_SPEED)),
  )
  const typedCommand = command.slice(0, typedChars)

  // Summary pops in after the last check has appeared.
  const summaryFrame = startFrame + 24 + checks.length * 8 + 10
  const pop = spring({
    frame: frame - summaryFrame,
    fps,
    config: { damping: 12 },
  })
  const summaryScale = 0.85 + 0.15 * pop
  const summaryOpacity = interpolate(frame, [summaryFrame, summaryFrame + 5], [0, 1], CLAMP)

  return (
    <div style={{ fontFamily: tokens.fontFamily.mono }}>
      <div
        style={{
          fontSize: 21,
          color: tokens.colors.terminal.foreground,
          whiteSpace: 'pre',
          opacity: frame >= startFrame ? 1 : 0,
        }}
      >
        <span style={{ color: tokens.colors.text.muted, fontWeight: 700 }}>{prefix}</span>
        {typedCommand}
      </div>

      {/* Blank gap, then the checks appear one by one. */}
      <div style={{ marginTop: 18 }}>
        {checks.map((check, i) => {
          const appear = startFrame + 24 + i * 8
          if (frame < appear) return null
          const opacity = interpolate(frame, [appear, appear + 5], [0, 1], CLAMP)
          const rise = interpolate(frame, [appear, appear + 5], [8, 0], CLAMP)
          return (
            <div
              key={check}
              style={{
                fontSize: 20,
                lineHeight: 1.8,
                opacity,
                transform: `translateY(${rise}px)`,
                whiteSpace: 'pre',
              }}
            >
              <span style={{ color: tokens.colors.terminal.brightGreen, fontWeight: 700 }}>
                {'✓ '}
              </span>
              <span style={{ color: tokens.colors.text.secondary }}>{check}</span>
            </div>
          )
        })}
      </div>

      {frame >= summaryFrame ? (
        <div
          style={{
            marginTop: 14,
            width: 'fit-content',
            fontSize: 23,
            fontWeight: 700,
            color: tokens.colors.terminal.brightGreen,
            opacity: summaryOpacity,
            transform: `scale(${summaryScale})`,
            transformOrigin: 'left center',
          }}
        >
          {summary}
        </div>
      ) : null}
    </div>
  )
}
