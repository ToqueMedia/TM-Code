import React from 'react'
import { tokens } from '../tokens'
import { StatusLine } from './StatusLine'

export interface TMCodeTerminalProps {
  width: number
  height: number
  children: React.ReactNode
  statusLabel: string
  statusKind: 'thinking' | 'working' | 'ready'
  tokensText?: string
  elapsedText?: string
  contextPct?: number
  /** When true the content hugs the bottom — like a scrolled terminal. */
  bottomAnchor?: boolean
}

/**
 * The terminal-mode surface that lives inside a MacWindowFrame body:
 * dark scrollback area + pinned StatusLine at the bottom.
 */
export const TMCodeTerminal: React.FC<TMCodeTerminalProps> = ({
  width,
  height,
  children,
  statusLabel,
  statusKind,
  tokensText,
  elapsedText,
  contextPct,
  bottomAnchor = false,
}) => {
  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        background: tokens.colors.bg.terminal,
        fontFamily: tokens.fontFamily.mono,
      }}
    >
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          padding: '26px 30px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          justifyContent: bottomAnchor ? 'flex-end' : undefined,
        }}
      >
        {children}
      </div>
      <StatusLine
        label={statusLabel}
        kind={statusKind}
        tokensText={tokensText}
        elapsedText={elapsedText}
        contextPct={contextPct}
      />
    </div>
  )
}
