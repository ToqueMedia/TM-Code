import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'

export interface PermissionPromptMockProps {
  /** Frame (local to the enclosing Sequence) at which the prompt opens. */
  startFrame: number
  /** Frame at which the prompt starts closing (fades/scales out over 8 frames). */
  closeFrame?: number
  /** Frame at which the Allow button visually presses. */
  allowPressFrame?: number
  /** Heading copy (kept English by brand rule). */
  title?: string
  /** Small uppercase severity label under the title. */
  subtitle?: string
  /** Mono command shown in the code box. */
  commandText?: string
  /** Panel width in px. */
  width?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// Purple-ish accent for the panel border (brand pink stays on the Allow button).
const PURPLE_BORDER = 'rgba(163, 113, 247, 0.25)'
// Soft purple glyph background.
const GLYPH_BG = 'rgba(163, 113, 247, 0.12)'
// Code box surface.
const CODE_BG = 'rgba(255, 255, 255, 0.04)'

// ─────────────────────────────────────────────────────────────────────────────
// Panel geometry (px), so scenes can aim the cursor at the Allow button.
// Panel: width 560, padding 28, boxSizing border-box → content width ≈ 504.
//   header row:  glyph 36 tall (aligned with title) → ≈ 36
//   subtitle:    11px uppercase / lineHeight 16px, marginTop 8 → 8 + 16 = 24
//   code box:    mono 16px, padding "10px 14px" → 10 + 16 + 10 = 36, marginTop 18 → 54
//   buttons:     marginTop 24, row height ≈ 42 (10+20+10 + 2px border) → 24 + 42 = 66
// Panel height ≈ 28 + 36 + 24 + 54 + 66 + 28 = 236 → panel center y ≈ 118.
//   Allow button: row top = 28 + 36 + 24 + 54 + 24 = 166; height 40 (10+20+10),
//   centered in the 42px row → center y ≈ 166 + 1 + 20 = 187 → offset +69.
//   Allow width ≈ 22 + ~54 ("Allow" @16px/600) + 22 = 98; its right edge sits at
//   +252 from panel center (504/2) → center x ≈ 252 − 49 = +203 ≈ +204.
// ─────────────────────────────────────────────────────────────────────────────
export const PERMISSION_LAYOUT = {
  width: 560,
  /** Allow button center, relative to the PANEL center. */
  allowButtonOffset: { x: 204, y: 69 },
} as const

/**
 * Authorization / permission prompt of the demo app. Renders absolutely over
 * its parent (inset 0). Fully frame-driven; renders null before startFrame and
 * after the close animation finishes. Mirrors ConfirmModal's entrance, close,
 * press and layout-export patterns.
 */
export const PermissionPromptMock: React.FC<PermissionPromptMockProps> = ({
  startFrame,
  closeFrame,
  allowPressFrame,
  title = 'Authorization needed',
  subtitle = 'Sensitive operation',
  commandText = 'execute  .  npm run deploy',
  width = 560,
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

  // Allow press: dip to 0.94 + brightness flash for ~6 frames.
  let pressT = 0
  if (allowPressFrame !== undefined) {
    pressT = interpolate(
      frame,
      [allowPressFrame, allowPressFrame + 3, allowPressFrame + 6],
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
          width,
          boxSizing: 'border-box',
          background: tokens.colors.dialog.bg,
          border: `1px solid ${PURPLE_BORDER}`,
          borderRadius: 14,
          padding: 28,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          transform: `scale(${enterScale * exitScale})`,
        }}
      >
        {/* Header: purple lock/shield glyph + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              flex: '0 0 auto',
              borderRadius: 10,
              background: GLYPH_BG,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2 4 5v6c0 4.5 3.2 8.4 8 9.8 4.8-1.4 8-5.3 8-9.8V5l-8-3Z"
                fill="none"
                stroke={tokens.colors.accent.purple}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
              <rect
                x={9}
                y={10.5}
                width={6}
                height={5}
                rx={1}
                fill="none"
                stroke={tokens.colors.accent.purple}
                strokeWidth={1.4}
              />
              <path
                d="M10.2 10.5V9.3a1.8 1.8 0 0 1 3.6 0v1.2"
                fill="none"
                stroke={tokens.colors.accent.purple}
                strokeWidth={1.4}
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div
            style={{
              fontSize: 21,
              lineHeight: '28px',
              fontWeight: 700,
              color: tokens.colors.text.primary,
            }}
          >
            {title}
          </div>
        </div>

        {/* Severity label */}
        <div
          style={{
            marginTop: 12,
            fontSize: 11,
            lineHeight: '16px',
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: tokens.colors.accent.orange,
          }}
        >
          {subtitle}
        </div>

        {/* Command code box */}
        <div
          style={{
            marginTop: 18,
            background: CODE_BG,
            borderRadius: 8,
            padding: '10px 14px',
            color: tokens.colors.text.secondary,
            fontFamily: tokens.fontFamily.mono,
            fontSize: 16,
            lineHeight: '20px',
            whiteSpace: 'pre',
            overflow: 'hidden',
          }}
        >
          {commandText}
        </div>

        {/* Button row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 12,
            marginTop: 24,
          }}
        >
          <span
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              color: tokens.colors.text.secondary,
              fontSize: 16,
              lineHeight: '20px',
              padding: '10px 20px',
              borderRadius: 8,
              whiteSpace: 'nowrap',
            }}
          >
            Deny
          </span>
          <span
            style={{
              background: tokens.gradient.accentPrimary,
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 16,
              lineHeight: '20px',
              padding: '10px 22px',
              borderRadius: 8,
              boxShadow: tokens.shadow.dialogButton,
              whiteSpace: 'nowrap',
              transform: `scale(${1 - 0.06 * pressT})`,
              filter: `brightness(${1 + 0.25 * pressT})`,
            }}
          >
            Allow
          </span>
        </div>
      </div>
    </div>
  )
}
