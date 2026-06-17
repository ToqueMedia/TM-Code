// Publish / deploy modal of the demo SaaS app (general-audience promo, scene 7).
// Two visual states driven by `liveFrame`:
//   • IN-PROGRESS — title + subtitle, a list of deploy steps that flip one by one
//     from "in progress" (amber spinner) to "done" (green check), and a thin
//     progress bar filling 0→100% across all steps.
//   • SUCCESS — the steps crossfade out and a green check circle, "Live!", a
//     message and a URL pill (mono, soft glow) with a copy button appear.
// Fully FRAME-DRIVEN (useCurrentFrame + interpolate/spring). Renders absolutely
// over its parent (inset 0), centered, on a backdrop that fades in over 8f.

import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'
import { DEPLOY_URL, PUBLISH_COPY, PUBLISH_STEPS } from '../../data/publishSteps'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export interface PublishModalMockProps {
  /** Frame (local to the enclosing Sequence) at which the modal opens. */
  startFrame: number
  /** Frames per deploy step (in-progress → done cadence). Default 16. */
  perStepFrames?: number
  /** Frame at which the modal flips from in-progress to the SUCCESS state. */
  liveFrame: number
  /** Frame at which the copy button visually presses (dip + flash, ~6f). */
  copyPressFrame?: number
  /** URL shown in the success pill. Default DEPLOY_URL. */
  url?: string
  /** Panel width in px. Default 640. */
  width?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel geometry (px), so scenes can aim the cursor at the copy button.
// Panel: width 640, padding 30, boxSizing border-box → content width = 580.
// SUCCESS state is a centered column (alignItems center) inside that content:
//   check circle: 64px                                   → 64
//   gap 20
//   "Live!": 28px / lineHeight 34px                      → 34
//   gap 8
//   liveMessage: 15px / lineHeight 22px                  → 22
//   gap 24
//   URL pill row: pill height 52 (16+18+18 padding)      → 52
// The copy button (36×36) is centered in that 52px-high row, at the right end of
// the row. The row spans the full 580px content width; the button's right edge
// aligns with the content's right edge.
//   Content right edge from panel center = 30 (left pad) + 580 − 320 = +290.
//   Copy button center x = 290 − 18 (half of 36)         → +272.
// Row vertical center from the content top:
//   64 + 20 + 34 + 8 + 22 + 24 + 26 (half of 52)         → 198.
// Content top from panel center: header(title+subtitle ≈ 30+8+22=60) is NOT in
// the success column — the success column REPLACES the body and is the only
// content, so its own height is 64+20+34+8+22+24+52 = 224 → column center y = 112,
// and the panel content top sits at −112 from panel center. Row center y from
// panel center = −112 + 198 = +86.
// ─────────────────────────────────────────────────────────────────────────────
export const PUBLISH_MODAL_LAYOUT = {
  width: 640,
  /** Copy button center, relative to the PANEL center. */
  copyButtonOffset: { x: 272, y: 86 },
} as const

/** Rotating spinner glyph (frame-driven, deterministic — no time/random APIs). */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * Publish modal of the demo SaaS app. Renders null before `startFrame`.
 * Fully frame-driven; mirrors ../ConfirmModal entrance + centering pattern.
 */
export const PublishModalMock: React.FC<PublishModalMockProps> = ({
  startFrame,
  perStepFrames = 16,
  liveFrame,
  copyPressFrame,
  url = DEPLOY_URL,
  width = 640,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  if (frame < startFrame) return null

  // Backdrop fades in over 8 frames from startFrame.
  const fadeIn = interpolate(frame, [startFrame, startFrame + 8], [0, 1], CLAMP)

  // Panel entrance: spring damping 16, scale 0.92 → 1.
  const enter = spring({ frame: frame - startFrame, fps, config: { damping: 16 } })
  const enterScale = 0.92 + 0.08 * enter

  // Crossfade between the two states around liveFrame (8f window).
  const successOpacity = interpolate(frame, [liveFrame, liveFrame + 8], [0, 1], CLAMP)
  const progressOpacity = interpolate(frame, [liveFrame - 4, liveFrame + 4], [1, 0], CLAMP)
  const isSuccess = frame >= liveFrame

  // Progress bar fill 0→100% across all steps (last step done = full).
  const lastDoneFrame = startFrame + 10 + (PUBLISH_STEPS.length - 1) * perStepFrames + perStepFrames
  const progress = interpolate(frame, [startFrame + 10, lastDoneFrame], [0, 1], CLAMP)

  // Copy press: dip to 0.92 + brightness flash for ~6 frames.
  let pressT = 0
  if (copyPressFrame !== undefined) {
    pressT = interpolate(
      frame,
      [copyPressFrame, copyPressFrame + 3, copyPressFrame + 6],
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
        opacity: fadeIn,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      <div
        style={{
          position: 'relative',
          width,
          boxSizing: 'border-box',
          background: tokens.colors.dialog.bg,
          border: `1px solid ${tokens.colors.dialog.border}`,
          borderRadius: 14,
          padding: 30,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          transform: `scale(${enterScale})`,
        }}
      >
        {/* ── IN-PROGRESS state ──────────────────────────────────────────── */}
        {progressOpacity > 0 ? (
          <div style={{ opacity: progressOpacity }}>
            <div
              style={{
                fontSize: 23,
                lineHeight: '30px',
                fontWeight: 700,
                color: tokens.colors.text.primary,
              }}
            >
              {PUBLISH_COPY.title}
            </div>
            <div
              style={{
                fontSize: 15,
                color: tokens.colors.text.secondary,
                lineHeight: 1.5,
                marginTop: 6,
              }}
            >
              {PUBLISH_COPY.subtitle}
            </div>

            {/* Thin progress bar under the header. */}
            <div
              style={{
                position: 'relative',
                height: 4,
                marginTop: 20,
                borderRadius: tokens.radius.pill,
                background: tokens.colors.bg.input,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${progress * 100}%`,
                  borderRadius: tokens.radius.pill,
                  background: tokens.gradient.logoTitle,
                }}
              />
            </div>

            {/* Deploy step rows. */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                marginTop: 24,
              }}
            >
              {PUBLISH_STEPS.map((label, i) => {
                const stepStart = startFrame + 10 + i * perStepFrames
                const stepDone = stepStart + perStepFrames
                const started = frame >= stepStart
                const done = frame >= stepDone

                const spinnerIndex =
                  Math.max(0, Math.floor(frame - stepStart)) % SPINNER_FRAMES.length

                return (
                  <div
                    key={label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      opacity: started ? 1 : 0.35,
                    }}
                  >
                    <span
                      style={{
                        width: 20,
                        textAlign: 'center',
                        fontSize: 16,
                        fontFamily: tokens.fontFamily.mono,
                        color: done
                          ? tokens.colors.accent.greenBright
                          : tokens.colors.toolCall.runningText,
                      }}
                    >
                      {done ? '✓' : SPINNER_FRAMES[spinnerIndex]}
                    </span>
                    <span
                      style={{
                        fontSize: 15,
                        color: done
                          ? tokens.colors.text.primary
                          : tokens.colors.text.secondary,
                      }}
                    >
                      {label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* ── SUCCESS state ──────────────────────────────────────────────── */}
        {isSuccess ? (
          <div
            style={{
              position: progressOpacity > 0 ? 'absolute' : 'relative',
              inset: progressOpacity > 0 ? 30 : undefined,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              opacity: successOpacity,
            }}
          >
            {/* Green check circle. */}
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: tokens.radius.pill,
                background: tokens.colors.accent.greenSubtle,
                border: `1px solid ${tokens.colors.accent.green}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: tokens.colors.accent.greenBright,
                fontSize: 32,
              }}
            >
              ✓
            </div>

            <div
              style={{
                fontSize: 28,
                lineHeight: '34px',
                fontWeight: 700,
                color: tokens.colors.text.primary,
                marginTop: 20,
              }}
            >
              {PUBLISH_COPY.live}
            </div>
            <div
              style={{
                fontSize: 15,
                lineHeight: '22px',
                color: tokens.colors.text.secondary,
                marginTop: 8,
              }}
            >
              {PUBLISH_COPY.liveMessage}
            </div>

            {/* URL pill row. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 24,
                width: '100%',
              }}
            >
              <div
                style={{
                  flex: 1,
                  boxSizing: 'border-box',
                  height: 52,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 20px',
                  borderRadius: tokens.radius.pill,
                  background: tokens.colors.bg.input,
                  border: `1px solid ${tokens.colors.border.glass}`,
                  boxShadow: `0 0 24px ${tokens.colors.accent.greenSubtle}, 0 0 0 1px ${tokens.colors.accent.primaryGlow}`,
                  fontFamily: tokens.fontFamily.mono,
                  fontSize: 16,
                  color: tokens.colors.text.primary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {url}
              </div>
              <div
                style={{
                  width: 36,
                  height: 36,
                  flex: '0 0 36px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: tokens.radius.lg,
                  background: tokens.colors.accent.primarySubtle,
                  border: `1px solid ${tokens.colors.accent.primaryGlow}`,
                  color: tokens.colors.accent.primary,
                  fontSize: 16,
                  transform: `scale(${1 - 0.1 * pressT})`,
                  filter: `brightness(${1 + 0.4 * pressT})`,
                }}
              >
                ⧉
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
