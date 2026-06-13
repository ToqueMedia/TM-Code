import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../tokens'
import { MODAL_TEXT } from '../data/mockUsers'

export interface ConfirmModalProps {
  /** Frame (local to the enclosing Sequence) at which the modal opens. */
  startFrame: number
  /** Frame at which the modal starts closing (fades/scales out over 8 frames). */
  closeFrame?: number
  /** Frame at which the Confirm button visually presses. */
  confirmPressFrame?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// ─────────────────────────────────────────────────────────────────────────────
// Panel geometry (px), so scenes can aim the cursor at the Confirm button.
// Panel: width 500, padding 30, boxSizing border-box → content width ≈ 438.
//   title:   23px / lineHeight 30px                          → 30
//   body:    17px / lineHeight 1.6 (27.2px), 2 lines in 438  → ≈ 54
//   buttons: marginTop 28, row height 44 (cancel 11+20+11 + 2px border)
// Panel height ≈ 30 + 30 + 12 + 54 + 28 + 44 + 30 = 228 → panel center y ≈ 114
// Confirm button: row top = 30+30+12+54+28 = 154; height 42 (11+20+11),
//   centered in the 44px row → center y ≈ 154 + 1 + 21 = 176 → offset +62.
// Confirm width ≈ 22 + ~78 ("Confirmar" @16px/600) + 22 = 122; its right edge
//   sits at +220 from panel center → center x ≈ 220 − 61 = +159 ≈ +160.
// ─────────────────────────────────────────────────────────────────────────────
export const MODAL_LAYOUT = {
  width: 500,
  /** Confirm button center, relative to the PANEL center. */
  confirmButtonOffset: { x: 160, y: 62 },
} as const

/**
 * Confirmation dialog of the Katondo Queue demo app. Renders absolutely over
 * its parent (inset 0). Fully frame-driven; renders null before startFrame and
 * after the close animation finishes.
 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  startFrame,
  closeFrame,
  confirmPressFrame,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  if (frame < startFrame) return null
  if (closeFrame !== undefined && frame >= closeFrame + 8) return null

  // Backdrop: fade in 8 frames, fade out 8 frames after closeFrame.
  const fadeIn = interpolate(frame, [startFrame, startFrame + 8], [0, 1], CLAMP)
  const fadeOut =
    closeFrame !== undefined ? interpolate(frame, [closeFrame, closeFrame + 8], [1, 0], CLAMP) : 1

  // Panel entrance: spring damping 16, scale 0.92 → 1 (+ fade with the backdrop).
  // Arithmetic mapping (not interpolate) so the spring's slight overshoot survives.
  const enter = spring({ frame: frame - startFrame, fps, config: { damping: 16 } })
  const enterScale = 0.92 + 0.08 * enter
  // Exit: scale to 0.97 over the 8-frame fade-out.
  const exitScale =
    closeFrame !== undefined
      ? interpolate(frame, [closeFrame, closeFrame + 8], [1, 0.97], CLAMP)
      : 1

  // Confirm press: dip to 0.94 + brightness flash for ~6 frames.
  let pressT = 0
  if (confirmPressFrame !== undefined) {
    pressT = interpolate(
      frame,
      [confirmPressFrame, confirmPressFrame + 3, confirmPressFrame + 6],
      [0, 1, 0],
      CLAMP,
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.colors.dialog.backdrop,
        opacity: fadeIn * fadeOut,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      <div
        style={{
          width: MODAL_LAYOUT.width,
          boxSizing: 'border-box',
          background: tokens.colors.dialog.bg,
          border: `1px solid ${tokens.colors.dialog.border}`,
          borderRadius: 14,
          padding: 30,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          transform: `scale(${enterScale * exitScale})`,
        }}
      >
        <div
          style={{
            fontSize: 23,
            lineHeight: '30px',
            fontWeight: 700,
            color: tokens.colors.text.primary,
          }}
        >
          {MODAL_TEXT.title}
        </div>
        <div
          style={{
            fontSize: 17,
            color: tokens.colors.text.secondary,
            lineHeight: 1.6,
            marginTop: 12,
          }}
        >
          {MODAL_TEXT.body}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 12,
            marginTop: 28,
          }}
        >
          <span
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              color: tokens.colors.text.secondary,
              fontSize: 16,
              lineHeight: '20px',
              padding: '11px 20px',
              borderRadius: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {MODAL_TEXT.cancel}
          </span>
          <span
            style={{
              background: tokens.gradient.accentPrimary,
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 16,
              lineHeight: '20px',
              padding: '11px 22px',
              borderRadius: 8,
              boxShadow: tokens.shadow.dialogButton,
              whiteSpace: 'nowrap',
              transform: `scale(${1 - 0.06 * pressT})`,
              filter: `brightness(${1 + 0.25 * pressT})`,
            }}
          >
            {MODAL_TEXT.confirm}
          </span>
        </div>
      </div>
    </div>
  )
}
