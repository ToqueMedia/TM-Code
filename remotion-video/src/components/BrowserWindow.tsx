import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'

/** Tab strip (40) + nav bar (48). Body height = height - BROWSER_CHROME_HEIGHT (minus 2px border). */
export const BROWSER_CHROME_HEIGHT = 88

const TAB_STRIP_HEIGHT = 40
const NAV_BAR_HEIGHT = 48

// Chrome-dark surfaces not present in the product tokens (browser mock only).
const TAB_ACTIVE_BG = '#1f1f1f'
const DEMO_APP_BG = '#0f1217'

export interface BrowserWindowProps {
  title: string
  url: string
  width: number
  height: number
  children: React.ReactNode
  /** Frame (local to the enclosing Sequence) at which the window springs in. Omit for always-visible. */
  entranceFrame?: number
  /** Favicon dot color (default tokens.colors.accent.blue). */
  accent?: string
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/**
 * Dark browser chrome (Edge/Chrome-style) hosting the mocked Katondo Queue
 * demo app. Same entrance treatment as MacWindowFrame: no-overshoot spring,
 * scale 0.97 → 1 + fade over ~12 frames, hidden before entranceFrame.
 */
export const BrowserWindow: React.FC<BrowserWindowProps> = ({
  title,
  url,
  width,
  height,
  children,
  entranceFrame,
  accent = tokens.colors.accent.blue,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  let opacity = 1
  let scale = 1
  if (entranceFrame !== undefined) {
    const enter = spring({
      frame: frame - entranceFrame,
      fps,
      config: { damping: 200 },
      durationInFrames: 12,
    })
    opacity = frame < entranceFrame ? 0 : enter
    scale = interpolate(enter, [0, 1], [0.97, 1], CLAMP)
  }

  return (
    <div
      style={{
        width,
        height,
        borderRadius: tokens.radius.window,
        border: `1px solid ${tokens.colors.border.default}`,
        background: tokens.colors.bg.app,
        boxShadow: tokens.shadow.window,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      {/* Tab strip */}
      <div
        style={{
          height: TAB_STRIP_HEIGHT,
          flexShrink: 0,
          background: tokens.colors.bg.panelAlt,
          display: 'flex',
          alignItems: 'flex-end',
          paddingLeft: 12,
        }}
      >
        {/* Active tab */}
        <div
          style={{
            width: 260,
            height: 34,
            borderRadius: '10px 10px 0 0',
            background: TAB_ACTIVE_BG,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
          }}
        >
          {/* Favicon dot */}
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: tokens.radius.pill,
              background: accent,
              flexShrink: 0,
            }}
          />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: tokens.fontFamily.ui,
              fontSize: 14,
              color: tokens.colors.text.secondary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontFamily: tokens.fontFamily.ui,
              fontSize: 16,
              color: tokens.colors.text.muted,
              flexShrink: 0,
            }}
          >
            ×
          </div>
        </div>
        {/* New-tab ghost button */}
        <div
          style={{
            width: 30,
            height: 34,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: 6,
            fontFamily: tokens.fontFamily.ui,
            fontSize: 18,
            color: tokens.colors.text.muted,
          }}
        >
          +
        </div>
      </div>

      {/* Nav bar */}
      <div
        style={{
          height: NAV_BAR_HEIGHT,
          flexShrink: 0,
          background: tokens.colors.bg.overlay,
          borderBottom: `1px solid ${tokens.colors.border.subtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 14px',
        }}
      >
        {(['‹', '›', '⟳'] as const).map((glyph) => (
          <div
            key={glyph}
            style={{
              fontFamily: tokens.fontFamily.ui,
              fontSize: 18,
              color: tokens.colors.text.muted,
              lineHeight: 1,
            }}
          >
            {glyph}
          </div>
        ))}
        {/* URL pill */}
        <div
          style={{
            flex: 1,
            height: 32,
            borderRadius: 16,
            background: tokens.colors.bg.panel,
            border: `1px solid ${tokens.colors.border.faint}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 14px',
          }}
        >
          {/* Lock glyph: rounded body + shackle */}
          <svg width={11} height={11} viewBox="0 0 11 11" style={{ flexShrink: 0 }}>
            <path
              d="M 3.2 5 V 3.4 a 2.3 2.3 0 0 1 4.6 0 V 5"
              fill="none"
              stroke={tokens.colors.accent.greenBright}
              strokeWidth={1.4}
              strokeLinecap="round"
            />
            <rect
              x={2}
              y={5}
              width={7}
              height={4.8}
              rx={1.4}
              fill="none"
              stroke={tokens.colors.accent.greenBright}
              strokeWidth={1.4}
            />
          </svg>
          <div
            style={{
              fontFamily: tokens.fontFamily.mono,
              fontSize: 15,
              color: tokens.colors.text.secondary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {url}
          </div>
        </div>
      </div>

      {/* Body — demo app dark base */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          background: DEMO_APP_BG,
        }}
      >
        {children}
      </div>
    </div>
  )
}
