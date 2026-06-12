import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../tokens'
import { DEMO_APP, FORCE_LOGOUT_LABEL, LOCKED_USER_INDEX, USERS } from '../data/mockUsers'
import { StatusBadge } from './StatusBadge'

export interface AdminUserManagementMockProps {
  width: number
  height: number
  /** Frame at which the locked user's badge flips to "Disponível". */
  statusSwitchFrame?: number
  /** Frame at which the "Forçar logout" button visually presses. */
  buttonPressFrame?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// ─────────────────────────────────────────────────────────────────────────────
// FIXED design geometry (design space). The spec's fixed column widths sum to
// more than 960px, so the dashboard is laid out on a fixed 1542px-wide design
// surface and uniformly scaled to fit the `width` prop. All exported
// coordinates account for that scale.
// ─────────────────────────────────────────────────────────────────────────────
const SIDEBAR_W = 220
const TABLE_MARGIN_X = 30
const COL_GAP = 12

const COLUMNS = [
  { label: 'Nome', width: 190 },
  { label: 'Email', width: 250 },
  { label: 'Role', width: 110 },
  { label: 'Estação', width: 110 },
  { label: 'Área', width: 130 },
  { label: 'Estado', width: 240 },
  { label: 'Ações', width: 160 },
] as const

// Sum of column widths = 190+250+110+110+130+240+160 = 1190
// Row width = 1190 + 6 gaps × 12 = 1262
const TABLE_W =
  COLUMNS.reduce((acc, c) => acc + c.width, 0) + (COLUMNS.length - 1) * COL_GAP // = 1262

/** Intrinsic design width: 220 (sidebar) + 30 + 1262 (table) + 30 = 1542 */
export const ADMIN_DESIGN_WIDTH = SIDEBAR_W + TABLE_MARGIN_X + TABLE_W + TABLE_MARGIN_X // = 1542

// Header block (design px): 26 padTop + 34 title line + 4 gap + 20 subtitle line + 18 padBottom
const HEADER_BLOCK_H = 26 + 34 + 4 + 20 + 18 // = 102
const THEAD_H = 48
const ROW_H = 72

/** Left edge (design space) of column `index` inside a row. Table starts at 220 + 30 = 250. */
const colLeft = (index: number): number =>
  SIDEBAR_W +
  TABLE_MARGIN_X +
  COLUMNS.slice(0, index).reduce((acc, c) => acc + c.width, 0) +
  index * COL_GAP
// colLeft(5) — Estado — = 250 + 790 + 60 = 1100
// colLeft(6) — Ações  — = 250 + 1030 + 72 = 1352

// Locked row (index 1) vertical center: 102 + 48 + 1×72 + 36 = 258
const LOCKED_ROW_CENTER_Y = HEADER_BLOCK_H + THEAD_H + LOCKED_USER_INDEX * ROW_H + ROW_H / 2 // = 258

// Estimated rendered widths (system-ui font; ± a few px):
// locked badge "Sessão activa — Balcão 2" @16px/600: 16 pad + 8 dot + 8 gap + ~190 text + 16 pad ≈ 238
const BADGE_EST_W = 238
const BADGE_H = 34 // 7 pad + 20 line + 7 pad
// "⏻ Forçar logout" @15px/600: 14 pad + ~118 text + 14 pad ≈ 146
const FORCE_BTN_EST_W = 146

/**
 * Click/highlight targets in COMPONENT space for an arbitrary render width
 * (the design surface is scaled by width / ADMIN_DESIGN_WIDTH).
 */
export const getAdminLayout = (width: number) => {
  const s = width / ADMIN_DESIGN_WIDTH
  return {
    forceLogoutButton: {
      x: (colLeft(6) + FORCE_BTN_EST_W / 2) * s, // (1352 + 73) × s
      y: LOCKED_ROW_CENTER_Y * s, // 258 × s
    },
    statusBadge: {
      x: (colLeft(5) + BADGE_EST_W / 2) * s, // (1100 + 119) × s
      y: LOCKED_ROW_CENTER_Y * s, // 258 × s
      width: BADGE_EST_W * s,
      height: BADGE_H * s,
    },
  }
}

/**
 * Targets for the standard 960×832 mount (scale = 960/1542 ≈ 0.6226):
 * forceLogoutButton ≈ { x: 887.2, y: 160.6 }
 * statusBadge ≈ { x: 758.9, y: 160.6, width: 148.2, height: 21.2 }
 */
export const ADMIN_LAYOUT = getAdminLayout(960)

const Cell: React.FC<{ width: number; children?: React.ReactNode }> = ({ width, children }) => (
  <div style={{ flex: `0 0 ${width}px`, width, minWidth: width, overflow: 'visible' }}>
    {children}
  </div>
)

/**
 * "Katondo Queue" admin dashboard mock (clean dark, blue accent). Fixed-pixel
 * design surface scaled to fit `width`; the page background extends to fill
 * `height` so any aspect ratio looks natural.
 */
export const AdminUserManagementMock: React.FC<AdminUserManagementMockProps> = ({
  width,
  height,
  statusSwitchFrame,
  buttonPressFrame,
}) => {
  const frame = useCurrentFrame()

  const scale = width / ADMIN_DESIGN_WIDTH
  const designHeight = height / scale

  // Locked-row tint fades to transparent over 15 frames after the status flips.
  const lockedTint =
    statusSwitchFrame !== undefined
      ? interpolate(frame, [statusSwitchFrame, statusSwitchFrame + 15], [1, 0], CLAMP)
      : 1

  // Force-logout button press: dip to 0.94 + background flash for ~6 frames.
  let pressT = 0
  if (buttonPressFrame !== undefined) {
    pressT = interpolate(
      frame,
      [buttonPressFrame, buttonPressFrame + 3, buttonPressFrame + 6],
      [0, 1, 0],
      CLAMP,
    )
  }
  const btnScale = 1 - 0.06 * pressT
  const btnBgAlpha = 0.06 + 0.12 * pressT

  // After the status flips, the button fades to 0.35 and reads "—".
  const btnOpacity =
    statusSwitchFrame !== undefined
      ? interpolate(frame, [statusSwitchFrame, statusSwitchFrame + 12], [1, 0.35], CLAMP)
      : 1
  const userFreed = statusSwitchFrame !== undefined && frame >= statusSwitchFrame + 6

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
          width: ADMIN_DESIGN_WIDTH,
          height: designHeight,
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
          display: 'flex',
        }}
      >
        {/* ── Sidebar ── */}
        <div
          style={{
            flex: `0 0 ${SIDEBAR_W}px`,
            width: SIDEBAR_W,
            background: '#0e1320',
            borderRight: '1px solid rgba(255,255,255,0.06)',
            padding: 18,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: tokens.colors.accent.blue,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 17, fontWeight: 700, color: tokens.colors.text.primary }}>
              {DEMO_APP.name}
            </span>
          </div>
          <div>
            {DEMO_APP.nav.map((item) => {
              const active = item === DEMO_APP.activeNav
              return (
                <div
                  key={item}
                  style={{
                    fontSize: 15,
                    color: active ? tokens.colors.accent.blueBright : tokens.colors.text.secondary,
                    fontWeight: active ? 600 : 400,
                    background: active ? tokens.colors.accent.blueSubtle : 'transparent',
                    padding: '11px 14px',
                    borderRadius: 8,
                    marginTop: 4,
                  }}
                >
                  {item}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Main area ── */}
        <div style={{ flex: 1, background: '#0f1217' }}>
          {/* Header: 26 + 34 + 4 + 20 + 18 = 102 tall */}
          <div
            style={{
              padding: '26px 30px 18px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 27,
                  lineHeight: '34px',
                  fontWeight: 700,
                  color: tokens.colors.text.primary,
                }}
              >
                {DEMO_APP.adminTitle}
              </div>
              <div
                style={{
                  fontSize: 15,
                  lineHeight: '20px',
                  color: tokens.colors.text.secondary,
                  marginTop: 4,
                }}
              >
                {DEMO_APP.adminSubtitle}
              </div>
            </div>
            <div
              style={{
                background: tokens.colors.accent.blue,
                color: '#ffffff',
                fontSize: 15,
                fontWeight: 600,
                padding: '9px 16px',
                borderRadius: 8,
                whiteSpace: 'nowrap',
              }}
            >
              Nova conta
            </div>
          </div>

          {/* ── Table ── */}
          <div style={{ margin: '0 30px', width: TABLE_W }}>
            {/* Header row, 48 tall */}
            <div
              style={{
                display: 'flex',
                gap: COL_GAP,
                alignItems: 'center',
                height: THEAD_H,
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {COLUMNS.map((c) => (
                <Cell key={c.label} width={c.width}>
                  <span
                    style={{
                      textTransform: 'uppercase',
                      fontSize: 13,
                      letterSpacing: '0.05em',
                      color: tokens.colors.text.muted,
                      fontWeight: 600,
                    }}
                  >
                    {c.label}
                  </span>
                </Cell>
              ))}
            </div>

            {/* Body rows, 72 tall each */}
            {USERS.map((user, i) => {
              const isLockedRow = i === LOCKED_USER_INDEX
              return (
                <div
                  key={user.email}
                  style={{
                    display: 'flex',
                    gap: COL_GAP,
                    alignItems: 'center',
                    height: ROW_H,
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    background: isLockedRow
                      ? `rgba(248,81,73,${0.04 * lockedTint})`
                      : 'transparent',
                  }}
                >
                  <Cell width={190}>
                    <span
                      style={{ fontSize: 17, fontWeight: 600, color: tokens.colors.text.primary }}
                    >
                      {user.name}
                    </span>
                  </Cell>
                  <Cell width={250}>
                    <span style={{ fontSize: 14, color: tokens.colors.text.secondary }}>
                      {user.email}
                    </span>
                  </Cell>
                  <Cell width={110}>
                    <span
                      style={{
                        display: 'inline-block',
                        fontFamily: tokens.fontFamily.mono,
                        fontSize: 13,
                        color: tokens.colors.text.muted,
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 6,
                        padding: '3px 8px',
                      }}
                    >
                      {user.role}
                    </span>
                  </Cell>
                  <Cell width={110}>
                    <span style={{ fontSize: 15, color: tokens.colors.text.assistant }}>
                      {user.station}
                    </span>
                  </Cell>
                  <Cell width={130}>
                    <span style={{ fontSize: 15, color: tokens.colors.text.assistant }}>
                      {user.area}
                    </span>
                  </Cell>
                  <Cell width={240}>
                    <StatusBadge
                      initial={user.status}
                      switchFrame={isLockedRow ? statusSwitchFrame : undefined}
                    />
                  </Cell>
                  <Cell width={160}>
                    {isLockedRow ? (
                      <span
                        style={{
                          display: 'inline-block',
                          border: '1px solid rgba(248,81,73,0.45)',
                          color: tokens.colors.accent.red,
                          background: `rgba(248,81,73,${btnBgAlpha})`,
                          borderRadius: 8,
                          fontSize: 15,
                          lineHeight: '18px',
                          fontWeight: 600,
                          padding: '9px 14px',
                          whiteSpace: 'nowrap',
                          opacity: btnOpacity,
                          transform: `scale(${btnScale})`,
                        }}
                      >
                        {userFreed ? '—' : `⏻ ${FORCE_LOGOUT_LABEL}`}
                      </span>
                    ) : (
                      <span style={{ fontSize: 15, color: tokens.colors.text.muted }}>—</span>
                    )}
                  </Cell>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
