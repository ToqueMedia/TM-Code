// Story scene 4 — Código + aprovação (210f / 7s). Big human build lines (no
// file names) + a short legible diff + "Aprovar alterações" → "✓ aprovadas".

import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { Caption, GeneralSceneBackground } from '../../components/general/sceneKit'
import { StructuredDiff } from '../../components/StructuredDiff'
import { AnimatedCursor } from '../../components/AnimatedCursor'
import { TargetMark } from '../../components/general/debugTargets'
import { STORY_BUILD_LINES, STORY_CAPTIONS, STORY_DIFF, STORY_DIFF_FOCUS } from '../../data/storyVertical'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const BTN = { left: 80, top: 1250, width: 920, height: 108 }
const BTN_T = { x: 540, y: BTN.top + BTN.height / 2 }

export const StoryBuildScene: React.FC = () => {
  const frame = useCurrentFrame()
  const btnIn = interpolate(frame, [88, 100], [0, 1], CLAMP)
  const press = interpolate(frame, [168, 171, 174], [0, 1, 0], CLAMP)
  const approved = interpolate(frame, [178, 188], [0, 1], CLAMP)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground />

      {/* Human build lines */}
      <div style={{ position: 'absolute', left: 90, top: 300, width: 900, fontFamily: tokens.fontFamily.ui }}>
        {STORY_BUILD_LINES.map((line, i) => {
          const appear = i * 11 - 8 // first line already present at frame 0 (no empty gap)
          const o = interpolate(frame, [appear, appear + 8], [0, 1], CLAMP)
          const tx = interpolate(frame, [appear, appear + 8], [-12, 0], CLAMP)
          return (
            <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 20, height: 70, opacity: o, transform: `translateX(${tx}px)` }}>
              <span style={{ width: 42, height: 42, borderRadius: 9999, background: tokens.colors.accent.greenSubtle, border: `1px solid ${tokens.colors.accent.green}`, color: tokens.colors.accent.greenBright, fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✓</span>
              <span style={{ fontSize: 42, fontWeight: 600, color: tokens.colors.text.primary }}>{line}</span>
            </div>
          )
        })}
      </div>

      {/* Short legible diff */}
      <div style={{ position: 'absolute', left: 80, top: 660, width: 920 }}>
        <StructuredDiff diff={STORY_DIFF} startFrame={54} framesPerLine={8} fontSize={28} highlightLines={STORY_DIFF_FOCUS} highlightStartFrame={96} highlightEndFrame={200} highlightColor={tokens.colors.accent.greenBright} highlightTint="rgba(46,160,67,0.16)" />
      </div>

      {/* Approve button */}
      <div style={{ position: 'absolute', left: BTN.left, top: BTN.top, width: BTN.width, height: BTN.height, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 38, fontWeight: 800, color: '#fff', overflow: 'hidden', fontFamily: tokens.fontFamily.ui, opacity: btnIn, transform: `scale(${1 - 0.03 * press})`, filter: `brightness(${1 + 0.2 * press})`, boxShadow: `0 0 ${44 * approved}px rgba(46,160,67,${0.6 * approved})` }}>
        <span style={{ position: 'absolute', inset: 0, background: tokens.gradient.accentPrimary, opacity: 1 - approved }} aria-hidden />
        <span style={{ position: 'absolute', inset: 0, background: tokens.colors.accent.greenSubtle, border: `1px solid ${tokens.colors.accent.green}`, boxSizing: 'border-box', opacity: approved }} aria-hidden />
        <span style={{ position: 'relative', color: approved > 0.5 ? tokens.colors.accent.greenBright : '#fff' }}>{approved > 0.5 ? '✓ Alterações aprovadas' : 'Aprovar alterações'}</span>
      </div>

      <AnimatedCursor appearFrame={138} disappearFrame={196} keyframes={[
        { frame: 138, x: BTN_T.x + 140, y: BTN_T.y + 170 },
        { frame: 160, x: BTN_T.x, y: BTN_T.y },
        { frame: 168, x: BTN_T.x, y: BTN_T.y, click: true },
        { frame: 190, x: BTN_T.x, y: BTN_T.y },
      ]} />
      <TargetMark x={BTN_T.x} y={BTN_T.y} w={BTN.width} h={BTN.height} />
      <Caption text={STORY_CAPTIONS.build} startFrame={0} endFrame={200} position="top" size={58} inset={140} />
    </AbsoluteFill>
  )
}
