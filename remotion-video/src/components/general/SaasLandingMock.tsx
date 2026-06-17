import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'

export interface SaasLandingMockProps {
  width: number
  height: number
  /** Frame at which the page content fades/rises in (preview load after refresh). */
  revealFrame?: number
  /** Frame at which the "Join waitlist" button presses + confirmation chip appears. */
  clickFrame?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// ─────────────────────────────────────────────────────────────────────────────
// FIXED design surface (design space). Everything is laid out on a 1000px-wide
// design surface and uniformly scaled to fit the `width` prop. The page
// background extends vertically (designHeight = height / scale) so any aspect
// ratio looks natural. All exported coordinates account for that scale.
// ─────────────────────────────────────────────────────────────────────────────
const DESIGN_W = 1000

const NAVBAR_H = 64
const PAGE_PAD_X = 64

// Hero block geometry (design space). Hero starts below the navbar.
const HERO_TOP = 110
const BUTTON_ROW_TOP = HERO_TOP + 52 + 16 + 24 + 36 // title + gap + subtitle + gap = 238

// "Join waitlist" button geometry (design space).
const WAITLIST_BTN_W = 156
const WAITLIST_BTN_H = 48
// The button row is centered; Google button + gap + waitlist button.
const GOOGLE_BTN_W = 226
const BTN_GAP = 16
const BTN_ROW_W = GOOGLE_BTN_W + BTN_GAP + WAITLIST_BTN_W // = 398
const BTN_ROW_LEFT = (DESIGN_W - BTN_ROW_W) / 2 // = 301
const WAITLIST_BTN_LEFT = BTN_ROW_LEFT + GOOGLE_BTN_W + BTN_GAP // = 543
const WAITLIST_BTN_CENTER_X = WAITLIST_BTN_LEFT + WAITLIST_BTN_W / 2 // = 621
const WAITLIST_BTN_CENTER_Y = BUTTON_ROW_TOP + WAITLIST_BTN_H / 2 // = 262

/**
 * Click target in COMPONENT space for an arbitrary render width
 * (the design surface is scaled by width / DESIGN_W).
 */
export const getLandingLayout = (width: number) => {
  const s = width / DESIGN_W
  return {
    waitlistButton: {
      x: WAITLIST_BTN_CENTER_X * s, // 621 × s
      y: WAITLIST_BTN_CENTER_Y * s, // 262 × s
    },
  }
}

// Faux bar chart — heights in design px (varied), drawn bottom-aligned.
const BAR_HEIGHTS = [88, 132, 64, 156, 108] as const

/**
 * Multi-color Google "G" dot — a small ring rendered with a conic-style
 * 4-color border so the Google button reads as a real OAuth button.
 */
const GoogleDot: React.FC = () => (
  <span
    style={{
      width: 18,
      height: 18,
      borderRadius: '50%',
      flexShrink: 0,
      display: 'inline-block',
      boxSizing: 'border-box',
      borderStyle: 'solid',
      borderWidth: 3,
      borderTopColor: '#ea4335',
      borderRightColor: '#fbbc05',
      borderBottomColor: '#34a853',
      borderLeftColor: '#4285f4',
    }}
  />
)

/**
 * SaaS landing-page mock (clean dark, BLUE accent — never pink, so it never
 * competes with the TM Code brand). Fixed-pixel design surface scaled to fit
 * `width`; the page background extends to fill `height`.
 *
 * revealFrame: before it, the page area is a faint near-empty skeleton; from
 * revealFrame the content fades in (0→1 over 12f) and rises (16→0) — this
 * simulates the preview loading after a refresh.
 *
 * clickFrame: the "Join waitlist" button presses (dip 0.94 + bg brightness
 * flash over ~6f); shortly after (clickFrame+6) an inline "Na lista!" chip
 * (green) appears beside it.
 */
export const SaasLandingMock: React.FC<SaasLandingMockProps> = ({
  width,
  height,
  revealFrame = 0,
  clickFrame,
}) => {
  const frame = useCurrentFrame()

  const scale = width / DESIGN_W
  const designHeight = height / scale

  // ── Reveal: content fades in + rises after revealFrame. ──
  const contentOpacity = interpolate(
    frame,
    [revealFrame, revealFrame + 12],
    [0, 1],
    CLAMP,
  )
  const contentRise = interpolate(
    frame,
    [revealFrame, revealFrame + 12],
    [16, 0],
    CLAMP,
  )
  // Faint skeleton sits underneath, fading out as content fades in.
  const skeletonOpacity = interpolate(
    frame,
    [revealFrame, revealFrame + 12],
    [1, 0],
    CLAMP,
  )

  // ── Click: button press dip + bg flash. ──
  let pressT = 0
  if (clickFrame !== undefined) {
    pressT = interpolate(
      frame,
      [clickFrame, clickFrame + 3, clickFrame + 6],
      [0, 1, 0],
      CLAMP,
    )
  }
  const btnScale = 1 - 0.06 * pressT
  // Brightness flash: lift from accent.blue toward blueBright during press.
  const btnBg = pressT > 0.5 ? tokens.colors.accent.blueBright : tokens.colors.accent.blue

  // ── Confirmation chip "Na lista!" appears at clickFrame + 6. ──
  const chipOpacity =
    clickFrame !== undefined
      ? interpolate(frame, [clickFrame + 6, clickFrame + 14], [0, 1], CLAMP)
      : 0
  const chipRise =
    clickFrame !== undefined
      ? interpolate(frame, [clickFrame + 6, clickFrame + 14], [6, 0], CLAMP)
      : 0

  return (
    <div
      style={{
        width,
        height,
        overflow: 'hidden',
        position: 'relative',
        background: '#0f1217',
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      <div
        style={{
          width: DESIGN_W,
          height: designHeight,
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
        }}
      >
        {/* ── Faint skeleton (visible before reveal) ── */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: skeletonOpacity,
            pointerEvents: 'none',
          }}
        >
          {/* skeleton navbar bar */}
          <div
            style={{
              position: 'absolute',
              top: 22,
              left: PAGE_PAD_X,
              width: 160,
              height: 20,
              borderRadius: tokens.radius.sm,
              background: 'rgba(255,255,255,0.04)',
            }}
          />
          {/* skeleton hero lines */}
          <div
            style={{
              position: 'absolute',
              top: HERO_TOP + 8,
              left: DESIGN_W / 2 - 240,
              width: 480,
              height: 36,
              borderRadius: tokens.radius.sm,
              background: 'rgba(255,255,255,0.04)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: HERO_TOP + 64,
              left: DESIGN_W / 2 - 160,
              width: 320,
              height: 16,
              borderRadius: tokens.radius.sm,
              background: 'rgba(255,255,255,0.03)',
            }}
          />
          {/* skeleton dashboard card */}
          <div
            style={{
              position: 'absolute',
              top: BUTTON_ROW_TOP + WAITLIST_BTN_H + 56,
              left: PAGE_PAD_X,
              right: PAGE_PAD_X,
              height: 240,
              borderRadius: tokens.radius.xl,
              background: 'rgba(255,255,255,0.02)',
            }}
          />
        </div>

        {/* ── Live content ── */}
        <div style={{ opacity: contentOpacity, transform: `translateY(${contentRise}px)` }}>
          {/* ── Navbar ── */}
          <div
            style={{
              height: NAVBAR_H,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `0 ${PAGE_PAD_X}px`,
              boxSizing: 'border-box',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {/* left: logo + wordmark */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 12,
                  background: tokens.colors.accent.blue,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 17, fontWeight: 700, color: tokens.colors.text.primary }}>
                SaaS Demo
              </span>
            </div>

            {/* center-right: nav links */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
              {['Produto', 'Preços', 'Sobre'].map((link) => (
                <span
                  key={link}
                  style={{ fontSize: 15, color: tokens.colors.text.secondary, fontWeight: 500 }}
                >
                  {link}
                </span>
              ))}
              {/* right: Login pill */}
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: tokens.colors.text.primary,
                  border: '1px solid rgba(255,255,255,0.14)',
                  borderRadius: tokens.radius.pill,
                  padding: '7px 18px',
                }}
              >
                Login
              </span>
            </div>
          </div>

          {/* ── Hero ── */}
          <div
            style={{
              position: 'absolute',
              top: HERO_TOP,
              left: 0,
              width: DESIGN_W,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: 52,
                lineHeight: '52px',
                fontWeight: 800,
                color: tokens.colors.text.primary,
                letterSpacing: '-0.02em',
              }}
            >
              Build your SaaS faster
            </h1>
            <p
              style={{
                margin: '16px 0 0',
                fontSize: 20,
                lineHeight: '24px',
                fontWeight: 400,
                color: tokens.colors.text.secondary,
              }}
            >
              Launch your idea with AI-assisted development.
            </p>

            {/* ── Button row ── */}
            <div
              style={{
                marginTop: 36,
                display: 'flex',
                alignItems: 'center',
                gap: BTN_GAP,
              }}
            >
              {/* Continuar com Google */}
              <div
                style={{
                  width: GOOGLE_BTN_W,
                  height: WAITLIST_BTN_H,
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  borderRadius: tokens.radius.pill,
                  border: '1px solid rgba(255,255,255,0.16)',
                  background: 'rgba(255,255,255,0.04)',
                  color: tokens.colors.text.primary,
                  fontSize: 15,
                  fontWeight: 600,
                }}
              >
                <GoogleDot />
                Continuar com Google
              </div>

              {/* Join waitlist (primary, blue) + inline chip */}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <div
                  style={{
                    width: WAITLIST_BTN_W,
                    height: WAITLIST_BTN_H,
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: tokens.radius.pill,
                    background: btnBg,
                    color: '#ffffff',
                    fontSize: 15,
                    fontWeight: 700,
                    transform: `scale(${btnScale})`,
                  }}
                >
                  Join waitlist
                </div>

                {/* "Na lista!" confirmation chip */}
                <div
                  style={{
                    position: 'absolute',
                    left: WAITLIST_BTN_W + 12,
                    top: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    whiteSpace: 'nowrap',
                    borderRadius: tokens.radius.pill,
                    border: `1px solid ${tokens.colors.accent.green}`,
                    background: tokens.colors.accent.greenSubtle,
                    color: tokens.colors.accent.greenBright,
                    fontSize: 13,
                    fontWeight: 700,
                    padding: '5px 12px',
                    opacity: chipOpacity,
                    transform: `translateY(calc(-50% + ${chipRise}px))`,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: tokens.colors.accent.greenBright,
                    }}
                  />
                  Na lista!
                </div>
              </div>
            </div>
          </div>

          {/* ── Dashboard preview card ── */}
          <div
            style={{
              position: 'absolute',
              top: BUTTON_ROW_TOP + WAITLIST_BTN_H + 56,
              left: PAGE_PAD_X,
              width: DESIGN_W - PAGE_PAD_X * 2,
              boxSizing: 'border-box',
              padding: 28,
              borderRadius: tokens.radius.xl,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              gap: 28,
            }}
          >
            {/* Faux bar chart */}
            <div
              style={{
                flex: '1 1 auto',
                height: 184,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 22,
                paddingBottom: 8,
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {BAR_HEIGHTS.map((h, i) => (
                <div
                  key={i}
                  style={{
                    flex: '1 1 0',
                    height: h,
                    borderRadius: `${tokens.radius.md}px ${tokens.radius.md}px 0 0`,
                    background: tokens.colors.accent.blue,
                    opacity: 0.55 + 0.45 * (h / 156),
                  }}
                />
              ))}
            </div>

            {/* Stat cards */}
            <div
              style={{
                flex: '0 0 220px',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              {[
                { label: 'Utilizadores', value: '2.481' },
                { label: 'MRR', value: '€12.4k' },
                { label: 'Conversão', value: '4.8%' },
              ].map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    boxSizing: 'border-box',
                    padding: '12px 16px',
                    borderRadius: tokens.radius.lg,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: tokens.colors.text.muted,
                      fontWeight: 600,
                    }}
                  >
                    {stat.label}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 22,
                      fontWeight: 800,
                      color: tokens.colors.accent.blueBright,
                    }}
                  >
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
