// worldCup.ts — seasonal "GOAL!" celebration (FIFA World Cup 2026).
//
// A successful, user-initiated agent run "scores a goal": a short burst plays
// on whichever surface is active (chat/welcome get a framer-motion confetti
// pop; the shell-styled surface gets a hard-step ASCII kick that respects the
// refined-terminal contract). This module is the single source of truth for
// the feature flag, palette and timing so the seasonal code is trivial to tune
// or pull in one place.
//
// Timing is intentionally "always on" (no date gate) per the product decision —
// flip FOOTBALL_MODE_ENABLED to false to remove every surface at once.

/** Master kill switch. `false` → no store writes, no overlays, no badge. */
export const FOOTBALL_MODE_ENABLED = true

/** Total wall-clock of the GUI burst before it fades out (ms). */
export const GOAL_BURST_MS = 1600

/**
 * Confetti palette for the GUI burst — dominant TM brand hues (pink → purple)
 * plus white and a single trophy-gold accent so it reads as celebratory
 * without leaving the brand. NOTE: the shell-styled surface does NOT use this
 * palette; the refined-shell contract allows only the single purple accent there.
 */
export const GOAL_CONFETTI_COLORS = [
  '#FE1063', // accent.primary
  '#C10A69', // accent.primaryDark
  '#a371f7', // accent.purple
  '#ffffff',
  '#FFD24A', // trophy gold — the one celebratory off-brand accent
] as const

/**
 * Honour the OS "reduce motion" setting. Exported here
 * so both the GUI and ASCII celebrations collapse to a static frame instead of
 * animating. Defensive try/catch — `matchMedia` is absent in some test envs.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
