// goalFrames.ts — the ASCII "GOAL!" animation for shell-styled surfaces.
//
// Refined-terminal contract: native terminals animate
// by swapping a CHARACTER at a fixed cell, frame by frame — never a smooth
// tween. So the terminal celebration is a precomputed list of single-line
// frames the component steps through once (no loop), at a discrete cadence.
// Pure and deterministic → unit-testable in isolation from React.

/** Discrete step cadence (ms). ~11fps reads as terminal frames, not a GUI spin. */
export const GOAL_FRAME_INTERVAL_MS = 90

// Cells the ball travels before it reaches the net.
const TRACK = 18
// Ball "spin" — the classic moon/clock hard-step set, single mono cells.
const SPIN = ['◐', '◓', '◑', '◒'] as const
// Net flash on impact.
const FLASH = ['▓', '█', '▒', '█'] as const

/**
 * Build the ordered frame list for one goal animation.
 *
 * Phase 1 — a spinning ball rolls left→right toward an empty net (`╢ ╟`),
 * advancing one cell and swapping its spin glyph each frame.
 * Phase 2 — impact: the net flashes and the (localised) word flips between a
 * ball and a spark on each side every tick, reading as a celebratory shimmer.
 *
 * @param rawWord The localised goal word (e.g. 'GOOOAL!' / 'GOOOLO!'). Trailing
 *                '!' is normalised and the letters are spaced out for the
 *                terminal banner look.
 */
export function buildGoalFrames(rawWord = 'GOOOAL!'): string[] {
  const letters = rawWord.replace(/!+$/u, '')
  const spaced = `${letters.split('').join(' ')} !`
  const frames: string[] = []

  // Phase 1 — roll toward the net.
  for (let p = 0; p <= TRACK; p++) {
    const ball = SPIN[p % SPIN.length]
    frames.push(`${' '.repeat(p)}${ball}${' '.repeat(TRACK - p)}  ╢ ╟`)
  }

  // Phase 2 — score + flash.
  for (let i = 0; i < 6; i++) {
    const lead = i % 2 === 0 ? '●' : '✦'
    const tail = i % 2 === 0 ? '✦' : '●'
    frames.push(`   ${lead}  ${spaced}  ${tail}    ╢${FLASH[i % FLASH.length]}╟`)
  }

  return frames
}
