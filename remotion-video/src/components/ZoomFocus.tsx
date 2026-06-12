import React from 'react'
import { Easing, interpolate, useCurrentFrame } from 'remotion'

export interface ZoomKeyframe {
  /** Frame (local to the enclosing Sequence). Must be strictly increasing across keyframes. */
  frame: number
  /** Zoom level. 1 = no zoom. */
  scale: number
  /** Focal point, in the CHILD's coordinate space (px) — the point that lands at container center. */
  x: number
  y: number
}

interface ZoomFocusProps {
  width: number
  height: number
  /**
   * Camera keyframes. With a single keyframe the camera is static.
   * For "no zoom" use { scale: 1, x: width / 2, y: height / 2 }.
   */
  keyframes: ZoomKeyframe[]
  children: React.ReactNode
  style?: React.CSSProperties
}

const CAMERA_EASE = Easing.bezier(0.33, 0, 0.15, 1)

/**
 * Cinematic camera: scales + pans its children so the focal point sits at the
 * container center. All motion is frame-driven (renders deterministically).
 */
export const ZoomFocus: React.FC<ZoomFocusProps> = ({ width, height, keyframes, children, style }) => {
  const frame = useCurrentFrame()

  let scale: number
  let fx: number
  let fy: number

  if (keyframes.length === 1) {
    scale = keyframes[0].scale
    fx = keyframes[0].x
    fy = keyframes[0].y
  } else {
    const input = keyframes.map((k) => k.frame)
    const opts = {
      easing: CAMERA_EASE,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    } as const
    scale = interpolate(frame, input, keyframes.map((k) => k.scale), opts)
    fx = interpolate(frame, input, keyframes.map((k) => k.x), opts)
    fy = interpolate(frame, input, keyframes.map((k) => k.y), opts)
  }

  const tx = width / 2 - fx * scale
  const ty = height / 2 - fy * scale

  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative', ...style }}>
      <div
        style={{
          width,
          height,
          position: 'absolute',
          top: 0,
          left: 0,
          transformOrigin: '0 0',
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
