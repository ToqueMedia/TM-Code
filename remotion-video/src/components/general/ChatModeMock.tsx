// Chat Mode IDE layout backbone — a two-column body (chat left, preview right)
// sized to fit inside a MacWindowFrame body. Fully DECOUPLED: the scene injects
// the chat transcript, prompt bar and preview as React nodes, so this file
// imports no sibling mocks (keeps geometry stable across scenes).

import React from 'react'
import { tokens } from '../../tokens'

export interface ChatModeMockProps {
  width: number
  height: number
  /** Chat transcript content (messages, reasoning blocks, tool-call rows). */
  chat: React.ReactNode
  /** Optional prompt bar pinned to the bottom of the chat column. */
  promptBar?: React.ReactNode
  /** Optional preview content for the right column. */
  preview?: React.ReactNode
  /** When true (and no `preview`), the right column shows a dim placeholder. */
  previewDim?: boolean
  /** Left (chat) column fraction of width. Default 0.54. */
  leftRatio?: number
  /** Bottom-anchor the chat transcript like a scrolled chat. Default true. */
  chatBottomAnchor?: boolean
}

const DimPreview: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      background: 'radial-gradient(ellipse at center, rgba(163,113,247,0.06), transparent 70%)',
    }}
  >
    <div
      style={{
        width: 60,
        height: 60,
        borderRadius: 16,
        border: `1px solid ${tokens.colors.border.glass}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: tokens.colors.text.disabled,
        fontSize: 26,
      }}
    >
      ▢
    </div>
    <div style={{ fontSize: 18, color: tokens.colors.text.disabled, fontFamily: tokens.fontFamily.ui }}>
      Preview
    </div>
  </div>
)

export const ChatModeMock: React.FC<ChatModeMockProps> = ({
  width,
  height,
  chat,
  promptBar,
  preview,
  previewDim = false,
  leftRatio = 0.54,
  chatBottomAnchor = true,
}) => {
  const leftW = Math.round(width * leftRatio)
  const rightW = width - leftW

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        background: tokens.colors.bg.app,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      {/* Left — chat column */}
      <div
        style={{
          width: leftW,
          height,
          display: 'flex',
          flexDirection: 'column',
          borderRight: `1px solid ${tokens.colors.border.subtle}`,
          background: tokens.colors.bg.app,
        }}
      >
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            padding: '30px 34px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            justifyContent: chatBottomAnchor ? 'flex-end' : 'flex-start',
          }}
        >
          {chat}
        </div>
        {promptBar ? <div style={{ padding: '0 26px 26px' }}>{promptBar}</div> : null}
      </div>

      {/* Right — preview column */}
      <div
        style={{
          width: rightW,
          height,
          position: 'relative',
          background: tokens.colors.bg.panel,
          overflow: 'hidden',
        }}
      >
        {preview ?? (previewDim ? <DimPreview /> : null)}
      </div>
    </div>
  )
}
