import React from 'react'
import { Easing, interpolate, useCurrentFrame } from 'remotion'

export interface CursorKeyframe {
  /** Frame (local to the enclosing Sequence). Strictly increasing across keyframes. */
  frame: number
  x: number
  y: number
  /** When true, a click happens AT this keyframe (press dip + ripple ring). */
  click?: boolean
}

interface AnimatedCursorProps {
  keyframes: CursorKeyframe[]
  /** Frame at which the cursor fades in (default: first keyframe). */
  appearFrame?: number
  /** Frame at which the cursor fades out (default: never). */
  disappearFrame?: number
  /** Cursor height in px (default 38 — sized for 1080p legibility). */
  size?: number
}

const MOVE_EASE = Easing.bezier(0.3, 0, 0.18, 1)
const CLICK_DURATION = 16

/**
 * macOS-style arrow cursor with smooth eased movement, press micro-scale and
 * an expanding click ripple. Position it inside the same coordinate space as
 * the UI it points at (so it tracks any ZoomFocus camera move).
 */
export const AnimatedCursor: React.FC<AnimatedCursorProps> = ({
  keyframes,
  appearFrame,
  disappearFrame,
  size = 38,
}) => {
  const frame = useCurrentFrame()

  const input = keyframes.map((k) => k.frame)
  const opts = {
    easing: MOVE_EASE,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  } as const

  const x =
    keyframes.length > 1 ? interpolate(frame, input, keyframes.map((k) => k.x), opts) : keyframes[0].x
  const y =
    keyframes.length > 1 ? interpolate(frame, input, keyframes.map((k) => k.y), opts) : keyframes[0].y

  const fadeStart = appearFrame ?? keyframes[0].frame
  let opacity = interpolate(frame, [fadeStart, fadeStart + 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  if (disappearFrame !== undefined) {
    opacity *= interpolate(frame, [disappearFrame, disappearFrame + 8], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  }

  // Click effects: press dip on the pointer + expanding ripple ring.
  let pressScale = 1
  const ripples: React.ReactNode[] = []
  for (const k of keyframes) {
    if (!k.click) continue
    const t = frame - k.frame
    if (t < 0 || t > CLICK_DURATION) continue
    const p = t / CLICK_DURATION
    // dip: 1 -> 0.85 -> 1 over the first 10 frames
    if (t <= 10) {
      const dip = t <= 5 ? t / 5 : (10 - t) / 5
      pressScale = 1 - 0.15 * dip
    }
    const rippleSize = interpolate(p, [0, 1], [14, 64], { easing: Easing.out(Easing.quad) })
    const rippleOpacity = interpolate(p, [0, 1], [0.55, 0])
    ripples.push(
      <div
        key={`ripple-${k.frame}`}
        style={{
          position: 'absolute',
          left: k.x - rippleSize / 2,
          top: k.y - rippleSize / 2,
          width: rippleSize,
          height: rippleSize,
          borderRadius: 9999,
          border: '2.5px solid rgba(255,255,255,0.85)',
          opacity: rippleOpacity,
          pointerEvents: 'none',
        }}
      />,
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity }}>
      {ripples}
      <svg
        viewBox="0 0 12 19"
        width={(size * 12) / 19}
        height={size}
        style={{
          position: 'absolute',
          left: x,
          top: y,
          transform: `scale(${pressScale})`,
          transformOrigin: '2px 2px',
          filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.5))',
        }}
      >
        {/* macOS arrow pointer */}
        <path
          d="M1 1 L1 15.5 L4.6 12.2 L6.8 17.4 L9.4 16.3 L7.2 11.2 L11.8 11.2 Z"
          fill="#ffffff"
          stroke="rgba(0,0,0,0.55)"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
