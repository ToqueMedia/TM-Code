import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { SAAS_PROJECT } from '../../data/mockProject'

export interface GeneralTerminalGreetingProps {
  /** Frame (local to the enclosing Sequence) at which the staggered entrance starts. */
  startFrame?: number
  projectName?: string
  projectPath?: string
  branch?: string
  tip?: string
}

// Exact TM CODE block banner of the real terminal-mode greeting.
const ASCII_BANNER = `████████ ███    ███      ██████  ██████  ██████  ███████
   ██    ████  ████     ██      ██    ██ ██   ██ ██
   ██    ██ ████ ██     ██      ██    ██ ██   ██ █████
   ██    ██  ██  ██     ██      ██    ██ ██   ██ ██
   ██    ██      ██      ██████  ██████  ██████  ███████`

/**
 * Terminal-mode welcome banner (ASCII logo, project line, branch, tip).
 * Each block fades in + rises 6px, staggered 5 frames apart.
 *
 * Project-agnostic copy of ../TerminalGreeting.tsx — sources the project
 * name/path/branch/tip from props (defaulted from SAAS_PROJECT) instead of
 * the /te2e PROJECT import.
 */
export const GeneralTerminalGreeting: React.FC<GeneralTerminalGreetingProps> = ({
  startFrame = 0,
  projectName = SAAS_PROJECT.name,
  projectPath = SAAS_PROJECT.path,
  branch = SAAS_PROJECT.branch,
  tip = 'type / to browse all commands',
}) => {
  const frame = useCurrentFrame()

  const blockEnter = (index: number): { opacity: number; transform: string } => {
    const start = startFrame + index * 5
    const opacity = interpolate(frame, [start, start + 8], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
    const rise = interpolate(frame, [start, start + 8], [6, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
    return { opacity, transform: `translateY(${rise}px)` }
  }

  const blockStyle = (index: number): React.CSSProperties => blockEnter(index)
  const banner = blockEnter(0)

  return (
    <div style={{ fontFamily: tokens.fontFamily.mono }}>
      {/* 1 — ASCII banner */}
      <pre
        style={{
          margin: 0,
          color: tokens.colors.accent.purple,
          opacity: 0.85 * banner.opacity,
          transform: banner.transform,
          fontSize: 15,
          lineHeight: 1.25,
          whiteSpace: 'pre',
          fontFamily: tokens.fontFamily.mono,
        }}
      >
        {ASCII_BANNER}
      </pre>

      {/* 2 — Welcome line */}
      <div
        style={{
          ...blockStyle(1),
          color: tokens.colors.terminal.green,
          fontSize: 21,
          fontWeight: 600,
          marginTop: 16,
        }}
      >
        Welcome to Terminal Mode
      </div>

      {/* 3 — Project name + path */}
      <div
        style={{
          ...blockStyle(2),
          fontSize: 18,
          color: tokens.colors.text.disabled,
          whiteSpace: 'pre',
          marginTop: 8,
        }}
      >
        {projectName}
        {'  '}
        <span style={{ opacity: 0.5 }}>{projectPath}</span>
      </div>

      {/* 4 — Branch + last commit */}
      <div
        style={{
          ...blockStyle(3),
          fontSize: 18,
          marginTop: 4,
          whiteSpace: 'pre',
        }}
      >
        <span style={{ color: tokens.colors.accent.green }}>{'→ ' + branch}</span>
        <span style={{ marginLeft: 12, opacity: 0.5, color: tokens.colors.text.disabled }}>
          {SAAS_PROJECT.lastCommit}
        </span>
      </div>

      {/* 5 — Divider */}
      <div
        style={{
          ...blockStyle(4),
          height: 1,
          background: 'rgba(255,255,255,0.06)',
          margin: '14px 0',
        }}
      />

      {/* 6 — Tip row */}
      <div
        style={{
          ...blockStyle(5),
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 18,
        }}
      >
        <span style={{ color: tokens.colors.accent.purple, fontWeight: 600 }}>tip:</span>
        <span style={{ color: tokens.colors.text.muted }}>{tip}</span>
      </div>
    </div>
  )
}
