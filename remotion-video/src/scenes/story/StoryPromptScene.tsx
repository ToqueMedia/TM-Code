// Story scene 2 — Pede no Chat (150f / 5s). One big chat panel: greeting + the
// user typing the /plan request with highlighted chips. Big, mobile-legible.

import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { STORY_CAPTIONS, STORY_PROMPT } from '../../data/storyVertical'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

const chip = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  background: 'rgba(255,255,255,0.07)',
  border: `1.5px solid ${color}`,
  color,
  borderRadius: 8,
  padding: '0 12px',
  fontWeight: 700,
})

const renderChips = (visible: string): React.ReactNode[] =>
  visible.split(' ').flatMap((tok, i) => {
    const s = tok.slice(0, 1)
    const node =
      (s === '/' || s === '#') && tok.length > 1 ? (
        <span key={i} style={chip(s === '/' ? tokens.colors.accent.primary : tokens.colors.accent.green)}>{tok}</span>
      ) : (
        <React.Fragment key={i}>{tok}</React.Fragment>
      )
    return i === 0 ? [node] : [<React.Fragment key={`s${i}`}> </React.Fragment>, node]
  })

export const StoryPromptScene: React.FC = () => {
  const frame = useCurrentFrame()
  const panel = interpolate(frame, [0, 6], [0.6, 1], CLAMP) // visible immediately (no empty gap)
  const panelY = interpolate(frame, [0, 8], [28, 0], CLAMP)

  const typed = Math.floor(Math.max(0, frame - 24) * 0.9)
  const visible = STORY_PROMPT.slice(0, typed)
  const done = typed >= STORY_PROMPT.length
  const caret = !done || Math.floor(frame / 16) % 2 === 0

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 960, opacity: panel, transform: `translateY(${panelY}px)`, fontFamily: tokens.fontFamily.ui }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
            <span style={{ color: tokens.colors.chat.assistantMarker, fontSize: 30 }}>◆</span>
            <span style={{ fontSize: 24, letterSpacing: '0.1em', color: tokens.colors.text.disabled, fontFamily: tokens.fontFamily.mono }}>TM CODE</span>
          </div>
          {/* assistant greeting */}
          <div style={{ background: tokens.colors.bg.card, borderRadius: 18, padding: '26px 30px', fontSize: 38, color: tokens.colors.text.assistant }}>
            Olá! O que queres construir?
          </div>
          {/* user prompt bar */}
          <div style={{ marginTop: 26, background: tokens.colors.bg.input, border: `1.5px solid ${tokens.colors.accent.primaryGlow}`, borderRadius: 22, padding: '28px 30px', display: 'flex', gap: 18, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, fontSize: 36, lineHeight: 1.5, color: tokens.colors.text.primary, whiteSpace: 'pre-wrap' }}>
              {renderChips(visible)}
              <span style={{ display: 'inline-block', width: 16, height: 36, background: tokens.colors.terminal.cursor, marginLeft: 3, verticalAlign: 'text-bottom', opacity: caret ? 0.9 : 0 }} />
            </div>
            <div style={{ width: 64, height: 64, borderRadius: 9999, background: tokens.gradient.accentPrimary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 32, fontWeight: 800, flexShrink: 0 }}>↑</div>
          </div>
        </div>
      </AbsoluteFill>
      <Caption text={STORY_CAPTIONS.prompt} startFrame={10} endFrame={140} position="top" size={64} inset={140} />
    </AbsoluteFill>
  )
}
