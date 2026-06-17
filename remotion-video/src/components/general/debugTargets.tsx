// Optional click-target debug overlay (NOT rendered in the final video).
// Set SHOW_TARGETS = true while iterating to verify the cursor hotspot lands
// inside each button's target rect, then set it back to false before rendering.

import React from 'react'

export const SHOW_TARGETS = false

export const TargetMark: React.FC<{ x: number; y: number; w?: number; h?: number }> = ({ x, y, w = 240, h = 120 }) => {
  if (!SHOW_TARGETS) return null
  return (
    <>
      <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, border: '2px solid #00e5ff', borderRadius: 8, pointerEvents: 'none', zIndex: 9999 }} />
      <div style={{ position: 'absolute', left: x - 7, top: y - 7, width: 14, height: 14, borderRadius: 9999, background: '#ffeb3b', pointerEvents: 'none', zIndex: 9999 }} />
    </>
  )
}
