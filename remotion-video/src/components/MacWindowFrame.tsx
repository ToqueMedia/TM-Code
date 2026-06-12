import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'

export const TITLEBAR_HEIGHT = 44

export interface MacWindowFrameProps {
  title: string
  subtitle?: string
  width: number
  height: number
  children: React.ReactNode
  /** Frame (local to the enclosing Sequence) at which the window springs in. Omit for always-visible. */
  entranceFrame?: number
  style?: React.CSSProperties
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/**
 * macOS-style app window chrome for the TM Code IDE. Entrance (when
 * entranceFrame is set) is a clean no-overshoot spring: scale 0.97 → 1 plus
 * fade 0 → 1 over ~12 frames. Fully hidden before entranceFrame.
 */
export const MacWindowFrame: React.FC<MacWindowFrameProps> = ({
  title,
  subtitle,
  width,
  height,
  children,
  entranceFrame,
  style,
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
        ...style,
      }}
    >
      {/* Titlebar */}
      <div
        style={{
          height: TITLEBAR_HEIGHT,
          flexShrink: 0,
          background: tokens.colors.bg.titlebar,
          borderBottom: `1px solid ${tokens.colors.border.subtle}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          position: 'relative',
        }}
      >
        {/* Traffic lights */}
        <div style={{ display: 'flex', gap: 8 }}>
          {(
            [
              tokens.colors.windowControl.close,
              tokens.colors.windowControl.minimize,
              tokens.colors.windowControl.maximize,
            ] as const
          ).map((color, i) => (
            <div
              key={i}
              style={{
                width: 13,
                height: 13,
                borderRadius: tokens.radius.pill,
                background: color,
              }}
            />
          ))}
        </div>
        {/* Absolutely centered title (so the dots never push it off-center) */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: tokens.fontFamily.ui,
            fontSize: 16,
            fontWeight: 500,
            color: tokens.colors.text.secondary,
            whiteSpace: 'pre',
            pointerEvents: 'none',
          }}
        >
          <span>{title}</span>
          {subtitle !== undefined ? (
            <span style={{ color: tokens.colors.text.muted }}>{'  —  ' + subtitle}</span>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          background: tokens.colors.bg.terminal,
        }}
      >
        {children}
      </div>
    </div>
  )
}
