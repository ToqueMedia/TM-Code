import { tokens } from '@/theme/tokens'

/* ── Box-shadow constants (internal) ── */

const PRIMARY_SHADOW = '0 0 20px rgba(254, 16, 99, 0.35), 0 4px 12px rgba(254, 16, 99, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
const PRIMARY_SHADOW_HOVER = '0 0 28px rgba(254, 16, 99, 0.5), 0 6px 16px rgba(254, 16, 99, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15)'

/* ── Shared button base (font, radius, transition) ── */

const btnBase: React.CSSProperties = {
  fontSize: '13px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  borderRadius: '12px',
  transition: `all ${tokens.transition.normal}`,
  letterSpacing: '0.01em',
}

/* ── Primary button (gradient, glow) ── */

export const primaryBtnStyle: React.CSSProperties = {
  ...btnBase,
  background: tokens.gradient.accentPrimary,
  border: '1px solid rgba(255, 255, 255, 0.12)',
  color: '#fff',
  fontWeight: '600',
  boxShadow: PRIMARY_SHADOW,
}

export function primaryHoverEnter(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.boxShadow = PRIMARY_SHADOW_HOVER
  e.currentTarget.style.transform = 'translateY(-1px)'
}

export function primaryHoverLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.boxShadow = PRIMARY_SHADOW
  e.currentTarget.style.transform = 'translateY(0)'
}

/* ── Secondary / ghost button (transparent, border) ── */

export const secondaryBtnStyle: React.CSSProperties = {
  ...btnBase,
  background: 'transparent',
  border: `1px solid ${tokens.colors.border.panel}`,
  color: tokens.colors.text.secondary,
  fontWeight: '500',
}

export function secondaryHoverEnter(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.borderColor = tokens.colors.text.muted
  e.currentTarget.style.background = tokens.colors.bg.hoverSubtle
}

export function secondaryHoverLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.borderColor = tokens.colors.border.panel
  e.currentTarget.style.background = 'transparent'
}

/* ── All CSS injected once in OnboardingFlow ── */

export const ONBOARDING_GLOBAL_STYLES = `
  .ob-btn:focus-visible,
  .ob-option:focus-visible,
  .ob-ready-btn:focus-visible {
    box-shadow: 0 0 0 2px ${tokens.colors.accent.primaryFocus} !important;
  }
  .ob-btn-primary,
  .ob-ready-primary {
    position: relative;
    overflow: hidden;
  }
  .ob-btn-primary::before,
  .ob-ready-primary::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 50%;
    background: linear-gradient(180deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0) 100%);
    border-radius: 12px 12px 0 0;
    pointer-events: none;
  }
`
