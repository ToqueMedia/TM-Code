// VS Code-style Source Control panel for the general promo (scene 8). Plays a
// frame-driven sequence: panel content fades in → the AI sparkle button presses
// and a shimmer sweeps the commit box → the commit message types itself into the
// box. Fully frame-driven (no CSS transitions / no randomness); colors come from
// tokens. The demo-app accent never appears here — this is the IDE chrome.

import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { CHANGED_FILES } from '../../data/mockProject'
import { COMMIT_MESSAGE } from '../../data/generalPromoScript'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// ─────────────────────────────────────────────────────────────────────────────
// Layout geometry (px). Everything is laid out from the panel left edge with a
// fixed horizontal PAD, so the sparkle button center is purely a function of
// `width`:
//   PAD                — panel horizontal padding (left & right)
//   COMMIT_BTN         — sparkle button size (30×30, square)
//   COMMIT_BTN_INSET   — gap from the commit box inner edge to the button
//   COMMIT_BOX_PAD     — commit box internal padding
// The sparkle button sits at the TOP-RIGHT of the commit message box. The box
// spans the full content width (panel width − 2·PAD). The button's right edge is
// inset COMMIT_BTN_INSET from the box's right edge, and its top is inset by the
// same amount from the box top. We only export the CENTER (x, y) here; the y is a
// stable constant because the box top is fixed by the rows above it.
// ─────────────────────────────────────────────────────────────────────────────
const PAD = 16
const COMMIT_BTN = 30
const COMMIT_BTN_INSET = 10

// Vertical stack down to the commit box top (must mirror the JSX below):
//   16 padTop
//   28 header row (height) + 16 marginBottom
//   24 branch row (height) + 18 marginBottom
//   20 "Changes" section label (height) + 10 marginBottom
//   CHANGED_FILES.length × (26 row + 4 gap)  (file rows)
//   16 marginBottom before the commit box
const FILE_ROW_H = 26
const FILE_ROW_GAP = 4
const COMMIT_BOX_TOP =
  16 + (28 + 16) + (24 + 18) + (20 + 10) + CHANGED_FILES.length * (FILE_ROW_H + FILE_ROW_GAP) + 16

/**
 * Sparkle ("generate commit message") button CENTER in component space. It sits
 * at the top-right corner of the commit message box: right edge inset
 * COMMIT_BTN_INSET from the content right edge (width − PAD), top inset
 * COMMIT_BTN_INSET from the box top (COMMIT_BOX_TOP).
 */
export const getSourceControlLayout = (width: number) => ({
  sparkleButton: {
    x: width - PAD - COMMIT_BTN_INSET - COMMIT_BTN / 2,
    y: COMMIT_BOX_TOP + COMMIT_BTN_INSET + COMMIT_BTN / 2,
  },
})

export interface SourceControlMockProps {
  /** Frame at which the panel content begins to fade in. */
  startFrame: number
  /** Frame at which the sparkle button presses + the commit box shimmers. */
  sparkleFrame: number
  /** Frame at which the commit message starts typing into the box. */
  commitTypeFrame: number
  /** The commit message that types in. Defaults to COMMIT_MESSAGE. */
  commitText?: string
  width: number
  height: number
}

const basename = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

const StatusBadge: React.FC<{ status: 'A' | 'M' }> = ({ status }) => {
  const color = status === 'A' ? tokens.colors.accent.greenBright : tokens.colors.accent.orange
  return (
    <span
      style={{
        width: 18,
        height: 18,
        flexShrink: 0,
        borderRadius: tokens.radius.sm,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: tokens.fontFamily.mono,
        fontSize: 12,
        fontWeight: 700,
        color,
        background: `${color}1f`,
      }}
    >
      {status}
    </span>
  )
}

/**
 * Source Control panel: header + change count, branch row, "Changes" file list,
 * an AI-assisted commit message box (placeholder → typewriter), and a Commit
 * button. The sparkle press (scene-local) precedes the typewriter.
 */
export const SourceControlMock: React.FC<SourceControlMockProps> = ({
  startFrame,
  sparkleFrame,
  commitTypeFrame,
  commitText = COMMIT_MESSAGE,
  width,
  height,
}) => {
  const frame = useCurrentFrame()

  // Panel content fades in over 8 frames from startFrame.
  const contentOpacity = interpolate(frame, [startFrame, startFrame + 8], [0, 1], CLAMP)

  // Sparkle press: dip 1 → 0.9 → 1 + brightness flash over ~6 frames.
  const pressT = interpolate(
    frame,
    [sparkleFrame, sparkleFrame + 3, sparkleFrame + 6],
    [0, 1, 0],
    CLAMP,
  )
  const sparkleScale = 1 - 0.1 * pressT
  const sparkleFlash = pressT // 0 → 1 → 0

  // Shimmer sweep across the commit box, just after the press (left → right).
  const shimmerX = interpolate(frame, [sparkleFrame, sparkleFrame + 14], [-40, 130], CLAMP)
  const shimmerOpacity = interpolate(
    frame,
    [sparkleFrame, sparkleFrame + 2, sparkleFrame + 12, sparkleFrame + 16],
    [0, 0.5, 0.5, 0],
    CLAMP,
  )

  // Typewriter: reveal commitText one char at a time after commitTypeFrame.
  const PER_CHAR = 1.4 // frames per character
  const typed = Math.max(
    0,
    Math.min(commitText.length, Math.floor((frame - commitTypeFrame) / PER_CHAR)),
  )
  const isTyping = frame >= commitTypeFrame
  const typedText = commitText.slice(0, typed)
  const typingDone = typed >= commitText.length

  // Blinking caret while typing (and briefly after) — frame-driven 2-state blink.
  const caretOn = Math.floor(frame / 15) % 2 === 0
  const showCaret = isTyping && (!typingDone || caretOn)

  const contentW = width - PAD * 2
  const changeCount = CHANGED_FILES.length

  return (
    <div
      style={{
        width,
        height,
        boxSizing: 'border-box',
        background: tokens.colors.bg.panel,
        fontFamily: tokens.fontFamily.ui,
        padding: PAD,
        opacity: contentOpacity,
        overflow: 'hidden',
        color: tokens.colors.text.primary,
      }}
    >
      {/* ── Header row ── */}
      <div
        style={{
          height: 28,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            textTransform: 'uppercase',
            fontSize: 12,
            letterSpacing: '0.08em',
            fontWeight: 600,
            color: tokens.colors.text.muted,
          }}
        >
          Source Control
        </span>
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: '0 6px',
            boxSizing: 'border-box',
            borderRadius: tokens.radius.pill,
            background: tokens.colors.accent.primarySubtle,
            color: tokens.colors.accent.primary,
            fontSize: 11,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {changeCount}
        </span>
      </div>

      {/* ── Branch row ── */}
      <div
        style={{
          height: 24,
          marginBottom: 18,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: tokens.colors.text.secondary,
        }}
      >
        {/* Branch glyph */}
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <circle cx={4} cy={3.5} r={2} stroke={tokens.colors.text.muted} strokeWidth={1.4} />
          <circle cx={4} cy={12.5} r={2} stroke={tokens.colors.text.muted} strokeWidth={1.4} />
          <circle cx={12} cy={3.5} r={2} stroke={tokens.colors.text.muted} strokeWidth={1.4} />
          <path
            d="M4 5.5 L4 10.5 M4 9 Q4 5.5 12 5.5"
            stroke={tokens.colors.text.muted}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
          />
        </svg>
        <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>main</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            fontSize: 11,
            color: tokens.colors.text.muted,
          }}
        >
          <span>↑</span>
          <span>1</span>
        </span>
      </div>

      {/* ── "Changes" section label ── */}
      <div
        style={{
          height: 20,
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            textTransform: 'uppercase',
            fontSize: 11,
            letterSpacing: '0.06em',
            fontWeight: 600,
            color: tokens.colors.text.muted,
          }}
        >
          Changes
        </span>
        <span style={{ fontSize: 11, color: tokens.colors.text.disabled }}>{changeCount}</span>
      </div>

      {/* ── Changed files list ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: FILE_ROW_GAP, marginBottom: 16 }}>
        {CHANGED_FILES.map((f) => {
          const dir = dirname(f.path)
          return (
            <div
              key={f.path}
              style={{
                height: FILE_ROW_H,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 4px',
                fontSize: 13,
              }}
            >
              <StatusBadge status={f.status} />
              <span style={{ color: tokens.colors.text.primary, fontWeight: 500, flexShrink: 0 }}>
                {basename(f.path)}
              </span>
              <span
                style={{
                  color: tokens.colors.text.muted,
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {dir}
              </span>
            </div>
          )
        })}
      </div>

      {/* ── Commit message box (textarea-like) ── */}
      <div
        style={{
          position: 'relative',
          boxSizing: 'border-box',
          width: contentW,
          minHeight: 84,
          background: tokens.colors.bg.input,
          border: `1px solid ${tokens.colors.border.default}`,
          borderRadius: tokens.radius.lg,
          padding: 12,
          overflow: 'hidden',
        }}
      >
        {/* Shimmer sweep (AI generating) — a soft diagonal band sweeping across. */}
        {shimmerOpacity > 0 ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${shimmerX}%`,
              width: '40%',
              opacity: shimmerOpacity,
              pointerEvents: 'none',
              background:
                'linear-gradient(105deg, transparent 0%, rgba(254,16,99,0.18) 50%, transparent 100%)',
            }}
          />
        ) : null}

        {/* Text area: placeholder until typing begins, then the typed message. */}
        <div
          style={{
            fontSize: 13,
            lineHeight: '20px',
            color: isTyping ? tokens.colors.text.primary : tokens.colors.text.muted,
            paddingRight: COMMIT_BTN + COMMIT_BTN_INSET, // keep clear of sparkle button
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            minHeight: 20,
          }}
        >
          {isTyping ? typedText : 'Mensagem de commit (Cmd+Enter)'}
          {showCaret ? (
            <span
              style={{
                display: 'inline-block',
                width: 1.5,
                height: 15,
                marginLeft: 1,
                verticalAlign: 'text-bottom',
                background: tokens.colors.accent.primary,
              }}
            />
          ) : null}
        </div>

        {/* Sparkle button (top-right of the box) */}
        <div
          style={{
            position: 'absolute',
            top: COMMIT_BTN_INSET,
            right: COMMIT_BTN_INSET,
            width: COMMIT_BTN,
            height: COMMIT_BTN,
            borderRadius: tokens.radius.md,
            background: tokens.colors.accent.primarySubtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${sparkleScale})`,
            boxShadow:
              sparkleFlash > 0
                ? `0 0 ${8 + 12 * sparkleFlash}px rgba(254,16,99,${0.2 + 0.4 * sparkleFlash})`
                : 'none',
          }}
        >
          <span
            style={{
              fontSize: 16,
              lineHeight: 1,
              fontWeight: 700,
              color: tokens.colors.accent.primary,
              filter: sparkleFlash > 0 ? `brightness(${1 + 0.6 * sparkleFlash})` : undefined,
            }}
          >
            ✦
          </span>
        </div>
      </div>

      {/* ── Commit button ── */}
      <div
        style={{
          marginTop: 12,
          width: contentW,
          boxSizing: 'border-box',
          background: tokens.gradient.accentPrimary,
          color: tokens.colors.text.inverse,
          fontWeight: 600,
          fontSize: 14,
          lineHeight: '20px',
          borderRadius: tokens.radius.md,
          padding: '10px 0',
          textAlign: 'center',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <circle cx={8} cy={8} r={3} stroke={tokens.colors.text.inverse} strokeWidth={1.6} />
          <path
            d="M1 8 L5 8 M11 8 L15 8"
            stroke={tokens.colors.text.inverse}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </svg>
        <span>Commit</span>
      </div>
    </div>
  )
}
