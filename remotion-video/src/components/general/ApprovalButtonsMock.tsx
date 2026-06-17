// Approve / Reject button row of the demo app's tool-approval prompt. Frame-
// driven: the row fades+rises in, the Approve button can press (dip + flash) and
// then crossfade to a green "Approved" confirmed state — all without changing
// size or position, so scenes can keep aiming the cursor at the same spot.

import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { tokens } from '../../tokens'

export interface ApprovalButtonsMockProps {
  /** Frame (local to the enclosing Sequence) at which the row enters. */
  startFrame: number
  /** Frame at which the Approve button visually presses (dip + brightness flash). */
  approvePressFrame?: number
  /** Frame at/after which the Approve button is in its green "Approved" state. */
  approvedFrame?: number
  /** Row width. Default "100%". */
  width?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// ─────────────────────────────────────────────────────────────────────────────
// Row geometry (px), so scenes can aim the cursor at the Approve button.
// Row: height 64, justify-content flex-end, align-items center, gap 12.
// Approve button: padding "11px 24px", fontSize 16 → height = 11+20+11 = 42,
//   width ≈ 24 + ~44 ("Approve" @16px/600) + 24 = ~92 → its right edge sits at
//   the container right edge; center x = right − width/2 ≈ right − 46.
//   We expose approveFromRight = 92 (container right − 92) as the AIM point so it
//   targets the button's interior, biased left of dead-center for a safe hit.
// centerY = 32 (row top + half the 64px height).
// ─────────────────────────────────────────────────────────────────────────────
export const APPROVAL_LAYOUT: { approveFromRight: number; centerY: number } = {
  approveFromRight: 92,
  centerY: 32,
}

/**
 * Approve / Reject row for the Katondo Queue demo app. Fully frame-driven; the
 * Approve button keeps an identical box across its default, pressed and
 * "Approved" states so the cursor target never moves.
 */
export const ApprovalButtonsMock: React.FC<ApprovalButtonsMockProps> = ({
  startFrame,
  approvePressFrame,
  approvedFrame,
  width,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Entrance: fade + rise over 12 frames from startFrame.
  const enter = spring({ frame: frame - startFrame, fps, config: { damping: 18 } })
  const fadeIn = interpolate(frame, [startFrame, startFrame + 12], [0, 1], CLAMP)
  const rise = interpolate(enter, [0, 1], [10, 0], CLAMP)

  // Approve press: dip to 0.94 + brightness flash for ~6 frames.
  let pressT = 0
  if (approvePressFrame !== undefined) {
    pressT = interpolate(
      frame,
      [approvePressFrame, approvePressFrame + 3, approvePressFrame + 6],
      [0, 1, 0],
      CLAMP,
    )
  }

  // Approved crossfade: 0 → 1 over 8 frames once approvedFrame is reached.
  const approvedT =
    approvedFrame !== undefined
      ? interpolate(frame, [approvedFrame, approvedFrame + 8], [0, 1], CLAMP)
      : 0

  return (
    <div
      style={{
        width: width ?? '100%',
        height: 64,
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 12,
        fontFamily: tokens.fontFamily.ui,
        opacity: fadeIn,
        transform: `translateY(${rise}px)`,
      }}
    >
      {/* Reject — subtle outline button. */}
      <span
        style={{
          border: '1px solid rgba(255, 255, 255, 0.14)',
          color: tokens.colors.text.secondary,
          fontSize: 16,
          lineHeight: '20px',
          padding: '11px 22px',
          borderRadius: 8,
          whiteSpace: 'nowrap',
        }}
      >
        Reject
      </span>

      {/* Approve — stacks default + confirmed states so the box never resizes. */}
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 600,
          fontSize: 16,
          lineHeight: '20px',
          padding: '11px 24px',
          borderRadius: 8,
          whiteSpace: 'nowrap',
          transform: `scale(${1 - 0.06 * pressT})`,
          filter: `brightness(${1 + 0.25 * pressT})`,
        }}
      >
        {/* Default (gradient) state — white label. The hidden checkmark reserves
            the exact width of the "✓ " glyph so the box matches the confirmed
            state and never resizes when the two crossfade. */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            opacity: 1 - approvedT,
          }}
        >
          <span style={{ visibility: 'hidden' }} aria-hidden>
            ✓&nbsp;
          </span>
          Approve
        </span>

        {/* Confirmed (green) state, layered on top — same metrics. */}
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.accent.greenBright,
            opacity: approvedT,
          }}
        >
          ✓&nbsp;Approved
        </span>

        {/* Background swaps gradient → green via stacked layers. */}
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 8,
            background: tokens.gradient.accentPrimary,
            boxShadow: tokens.shadow.dialogButton,
            opacity: 1 - approvedT,
            zIndex: -1,
          }}
          aria-hidden
        />
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 8,
            background: tokens.colors.accent.greenSubtle,
            border: '1px solid rgba(46, 160, 67, 0.4)',
            boxSizing: 'border-box',
            opacity: approvedT,
            zIndex: -1,
          }}
          aria-hidden
        />
      </span>
    </div>
  )
}
