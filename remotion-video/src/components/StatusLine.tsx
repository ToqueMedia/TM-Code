import React from 'react'
import { useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'

export interface StatusLineProps {
  label: string
  kind: 'thinking' | 'working' | 'ready'
  /** Model name shown after the label (default "tm-agent-pro"). */
  model?: string
  /** Context usage percentage segment (omitted when undefined). */
  contextPct?: number
  /** e.g. "11.8k tokens" */
  tokensText?: string
  /** Far-right elapsed time, e.g. "1m 32s" */
  elapsedText?: string
}

const Separator: React.FC = () => <span style={{ color: tokens.colors.text.disabled }}>·</span>

/**
 * Bottom status bar of TM Code terminal mode: pulsing status dot, animated
 * ellipsis while busy, model / context / tokens segments and elapsed time.
 */
export const StatusLine: React.FC<StatusLineProps> = ({
  label,
  kind,
  model = 'tm-agent-pro',
  contextPct,
  tokensText,
  elapsedText,
}) => {
  const frame = useCurrentFrame()

  const isReady = kind === 'ready'
  const dotColor = isReady ? tokens.colors.status.running : tokens.colors.status.thinking
  const dotOpacity = isReady ? 1 : 0.45 + 0.55 * Math.abs(Math.sin(frame / 9))
  const ellipsis = isReady ? '' : '.'.repeat(Math.floor(frame / 10) % 4)

  return (
    <div
      style={{
        height: 46,
        borderTop: '1px solid ' + tokens.colors.border.faint,
        background: 'rgba(10,10,10,0.92)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 14,
        fontFamily: tokens.fontFamily.mono,
        fontSize: 17,
        color: tokens.colors.text.secondary,
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: tokens.radius.pill,
          background: dotColor,
          opacity: dotOpacity,
          flexShrink: 0,
        }}
      />
      <span>
        {label}
        {ellipsis}
      </span>
      <Separator />
      <span>{model}</span>
      {contextPct !== undefined ? (
        <>
          <Separator />
          <span>{'context ' + contextPct + '%'}</span>
        </>
      ) : null}
      {tokensText !== undefined ? (
        <>
          <Separator />
          <span>{tokensText}</span>
        </>
      ) : null}
      {elapsedText !== undefined ? (
        <span style={{ marginLeft: 'auto', color: tokens.colors.text.muted }}>{elapsedText}</span>
      ) : null}
    </div>
  )
}
