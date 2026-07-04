// terminalSpinner.ts — the ONE sanctioned "activity" animation for shell-styled surfaces.
//
// Refined-terminal contract: native terminals never rotate a glyph or sweep a
// gradient across text — they animate by swapping a CHARACTER at a fixed cell,
// frame by frame (the classic braille/line spinner of ora, npm, cargo, etc.).
// Every eased/looping CSS animation in this surface (toolSpin rotation,
// terminalThinkingShimmer gradient-clip, the breathing pulse dots) is replaced
// by this hook so the whole surface shares one hard-step idiom — matching the
// already-correct `blink` (cursor) and `logDotBlink` keyframes.
//
// Respects prefers-reduced-motion: when the user asks for reduced motion we
// hold a single static frame instead of cycling (no interval, no re-renders).

import { useEffect, useRef, useState, createElement, type ReactElement } from 'react'

// Braille spinner — the de-facto CLI spinner. Reads as a single dense mono
// cell that "fills" around the clock, never leaving the cell grid.
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

// Slower three-state dot cycle for "waiting"/"thinking" affordances that read
// better as accumulating dots than a whirring spinner.
export const DOTS_FRAMES = ['·  ', '·· ', '···'] as const

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Cycle through `frames` while `active`, returning the current frame string.
 *
 * - Inactive → always returns `frames[0]` (a stable, static glyph; no interval).
 * - prefers-reduced-motion → holds `frames[0]` even while active.
 * - Default cadence ~12.5fps (80ms): fast enough to read as "working", slow
 *   enough to feel like discrete terminal frames rather than a smooth GUI spin.
 */
export function useSpinnerFrame(
  active: boolean,
  frames: readonly string[] = SPINNER_FRAMES,
  intervalMs = 80,
): string {
  const [index, setIndex] = useState(0)
  // Keep the latest frame count without re-subscribing the interval.
  const lenRef = useRef(frames.length)
  lenRef.current = frames.length

  useEffect(() => {
    if (!active || prefersReducedMotion()) return
    const id = setInterval(() => {
      setIndex(i => (i + 1) % lenRef.current)
    }, intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])

  if (!active) return frames[0]
  return frames[index % frames.length]
}

/**
 * Drop-in spinner element. Use this (instead of the hook) wherever the
 * indicator is rendered inside a `.map()`, a conditional, or otherwise not at
 * the top level of a component — calling `useSpinnerFrame` there would violate
 * the rules of hooks. Renders a bare <span> that inherits the parent's color
 * and mono font; wrap it in a colored Text/Box to theme it.
 */
export function Spinner(props: {
  active: boolean
  frames?: readonly string[]
  intervalMs?: number
}): ReactElement {
  const frame = useSpinnerFrame(props.active, props.frames, props.intervalMs)
  return createElement('span', { 'aria-hidden': true, style: { fontVariantEmoji: 'text' } }, frame)
}
