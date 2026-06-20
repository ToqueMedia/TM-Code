// Shared visual kit for the general promo — locks one consistent motion/style
// language across all 9 scenes (background glow, overlay captions, edge fades).
// Frame-driven only; colors from tokens.

import React from 'react'
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'

export const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
export const EASE_OUT = Easing.out(Easing.cubic)
export const RISE = { ...CLAMP, easing: EASE_OUT } as const

/**
 * Opacity that fades in over the first `inF` frames and out over the last `outF`
 * frames of a scene of length `duration`. Use it on a scene's root AbsoluteFill
 * so cuts between scenes are clean.
 */
export const edgeFade = (frame: number, duration: number, inF = 8, outF = 8): number =>
  interpolate(frame, [0, inF], [0, 1], CLAMP) *
  interpolate(frame, [duration - outF, duration], [1, 0], CLAMP)

/**
 * Deep-dark background + brand radial glow. Drop it as the first child of a
 * scene's root AbsoluteFill. `drift` adds a slow cinematic push-in.
 */
export const GeneralSceneBackground: React.FC<{ drift?: boolean }> = ({ drift = false }) => {
  const frame = useCurrentFrame()
  const s = drift ? interpolate(frame, [0, 260], [1, 1.06], CLAMP) : 1
  return (
    <>
      <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }} />
      <AbsoluteFill
        style={{ background: tokens.gradient.welcomeGlow, transform: `scale(${s})`, transformOrigin: 'center' }}
      />
    </>
  )
}

export interface CaptionProps {
  text: string
  /** Frame (scene-local) at which the caption rises/fades in. */
  startFrame: number
  /** Frame at which it fades/drops out (over 12 frames). Omit to keep visible. */
  endFrame?: number
  position?: 'top' | 'bottom' | 'center'
  /** Optional sub-line under the headline. */
  sub?: string
  /** Use the brand gradient for the text instead of solid white. */
  gradient?: boolean
  /** Headline font size (default 46). */
  size?: number
  /** Override the top/bottom edge inset in px (mobile safe areas). */
  inset?: number
}

/**
 * Premium overlay caption — the single message of a scene. Fades + rises in,
 * fades + drops out before endFrame. Centered horizontally in a top/bottom/center
 * band. Sits above the UI (pointerEvents none).
 */
export const Caption: React.FC<CaptionProps> = ({
  text,
  startFrame,
  endFrame,
  position = 'bottom',
  sub,
  gradient = false,
  size = 46,
  inset,
}) => {
  const frame = useCurrentFrame()

  let opacity = interpolate(frame, [startFrame, startFrame + 12], [0, 1], CLAMP)
  const rise = interpolate(frame, [startFrame, startFrame + 14], [22, 0], RISE)
  let drop = 0
  if (endFrame !== undefined) {
    opacity *= interpolate(frame, [endFrame, endFrame + 12], [1, 0], CLAMP)
    drop = interpolate(frame, [endFrame, endFrame + 12], [0, 12], CLAMP)
  }
  if (opacity <= 0) return null

  const ty = rise + drop
  const vertical: React.CSSProperties =
    position === 'top' ? { top: inset ?? 96 } : position === 'center' ? { top: '50%' } : { bottom: inset ?? 104 }
  const transform =
    position === 'center' ? `translateY(calc(-50% + ${ty}px))` : `translateY(${ty}px)`

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        ...vertical,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        opacity,
        transform,
        pointerEvents: 'none',
        fontFamily: tokens.fontFamily.ui,
        textAlign: 'center',
        padding: '0 90px',
      }}
    >
      <div
        style={{
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1.14,
          letterSpacing: '-0.01em',
          color: gradient ? 'transparent' : tokens.colors.text.primary,
          backgroundImage: gradient ? tokens.gradient.heroTitle : undefined,
          WebkitBackgroundClip: gradient ? 'text' : undefined,
          backgroundClip: gradient ? 'text' : undefined,
          textShadow: gradient ? undefined : '0 2px 28px rgba(0,0,0,0.6)',
        }}
      >
        {text}
      </div>
      {sub ? (
        <div
          style={{
            fontSize: 24,
            fontWeight: 500,
            color: tokens.colors.text.secondary,
            textShadow: '0 2px 16px rgba(0,0,0,0.65)',
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}
