// Scene 8 — the proof: an external browser where the deployed URL is pasted into
// the address bar, Enter is pressed, a load bar runs, and the published page
// (SaasLandingMock, refined) appears. Chrome mirrors ../BrowserWindow; the
// address bar and body are frame-driven.

import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'
import { SaasLandingMock } from './SaasLandingMock'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const TAB_STRIP_H = 40
const NAV_BAR_H = 48
const CHROME_H = TAB_STRIP_H + NAV_BAR_H

export interface PublishedBrowserMockProps {
  width: number
  height: number
  url: string
  /** Frame at which the URL starts typing/pasting into the address bar. */
  typeStartFrame: number
  /** Frame at which Enter is pressed (caret hides, load bar starts). */
  enterFrame: number
  /** Frame at which the published page finishes loading and reveals. */
  loadFrame: number
  /** Window spring-in frame. */
  entranceFrame?: number
  /** Chars/frame for the address typewriter (default 2.4 — fast, like a paste). */
  charsPerFrame?: number
}

export const PublishedBrowserMock: React.FC<PublishedBrowserMockProps> = ({
  width,
  height,
  url,
  typeStartFrame,
  enterFrame,
  loadFrame,
  entranceFrame,
  charsPerFrame = 2.4,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  let opacity = 1
  let scale = 1
  if (entranceFrame !== undefined) {
    const enter = spring({ frame: frame - entranceFrame, fps, config: { damping: 200 }, durationInFrames: 12 })
    opacity = frame < entranceFrame ? 0 : enter
    scale = interpolate(enter, [0, 1], [0.97, 1], CLAMP)
  }

  const typedCount = Math.floor(Math.max(0, frame - typeStartFrame) * charsPerFrame)
  const typing = frame < enterFrame
  const shownUrl = typing ? url.slice(0, typedCount) : url
  const caretVisible = typing && frame >= typeStartFrame && Math.floor(frame / 12) % 2 === 0

  const loaded = frame >= loadFrame
  const loadProgress = interpolate(frame, [enterFrame, loadFrame], [0, 1], CLAMP)

  const bodyW = width - 2
  const bodyH = height - 2 - CHROME_H
  const host = url.replace(/^https?:\/\//, '')

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
      <div style={{ height: TAB_STRIP_H, flexShrink: 0, background: tokens.colors.bg.panelAlt, display: 'flex', alignItems: 'flex-end', paddingLeft: 12 }}>
        <div style={{ width: 280, height: 34, borderRadius: '10px 10px 0 0', background: '#1f1f1f', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px' }}>
          <div style={{ width: 10, height: 10, borderRadius: tokens.radius.pill, background: loaded ? tokens.colors.accent.blue : tokens.colors.text.disabled, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, fontFamily: tokens.fontFamily.ui, fontSize: 14, color: tokens.colors.text.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {loaded ? 'Startup Demo' : 'Nova aba'}
          </div>
          <div style={{ fontFamily: tokens.fontFamily.ui, fontSize: 16, color: tokens.colors.text.muted, flexShrink: 0 }}>×</div>
        </div>
        <div style={{ width: 30, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: 6, fontFamily: tokens.fontFamily.ui, fontSize: 18, color: tokens.colors.text.muted }}>+</div>
      </div>

      {/* Nav bar with animated address pill */}
      <div style={{ height: NAV_BAR_H, flexShrink: 0, background: tokens.colors.bg.overlay, borderBottom: `1px solid ${tokens.colors.border.subtle}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px' }}>
        {(['‹', '›', '⟳'] as const).map((g) => (
          <div key={g} style={{ fontFamily: tokens.fontFamily.ui, fontSize: 18, color: tokens.colors.text.muted, lineHeight: 1 }}>{g}</div>
        ))}
        <div style={{ flex: 1, height: 32, borderRadius: 16, background: tokens.colors.bg.panel, border: `1px solid ${loaded ? tokens.colors.border.faint : tokens.colors.accent.primaryGlow}`, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px' }}>
          {loaded ? (
            <svg width={11} height={11} viewBox="0 0 11 11" style={{ flexShrink: 0 }}>
              <path d="M 3.2 5 V 3.4 a 2.3 2.3 0 0 1 4.6 0 V 5" fill="none" stroke={tokens.colors.accent.greenBright} strokeWidth={1.4} strokeLinecap="round" />
              <rect x={2} y={5} width={7} height={4.8} rx={1.4} fill="none" stroke={tokens.colors.accent.greenBright} strokeWidth={1.4} />
            </svg>
          ) : null}
          <div style={{ fontFamily: tokens.fontFamily.mono, fontSize: 15, color: tokens.colors.text.primary, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {loaded ? host : shownUrl}
            {caretVisible ? <span style={{ display: 'inline-block', width: 2, height: 16, background: tokens.colors.terminal.cursor, marginLeft: 1, verticalAlign: 'middle' }} /> : null}
          </div>
        </div>
      </div>

      {/* Load bar */}
      {!loaded && frame >= enterFrame ? (
        <div style={{ position: 'absolute', top: CHROME_H, left: 0, height: 3, width: `${loadProgress * 100}%`, background: tokens.colors.accent.blueBright, zIndex: 2 }} />
      ) : null}

      {/* Body */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0f1217' }}>
        {/* Rendered from the start so the body shows a live skeleton (never empty),
            then reveals the premium page at loadFrame. */}
        <SaasLandingMock width={bodyW} height={bodyH} polish={1} revealFrame={loadFrame} />
      </div>
    </div>
  )
}
