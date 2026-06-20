import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Box } from '@chakra-ui/react'
import { motion, useReducedMotion, useTime, useTransform, type MotionValue } from 'framer-motion'
import { FootballMark } from './FootballMark'
import { FOOTBALL_MODE_ENABLED } from '@/utils/worldCup'
import { tokens } from '@/theme/tokens'

// WelcomeRunner — a never-ending little footballer that jogs ACROSS the hero
// title, dribbling the ball, then volleys it, traps the return on the chest and
// turns to run the other way. Forever (the user asked for "um que não pára").
//
// Why it's built the way it is:
//  • One clock. Everything (figure + ball) is derived from a single `useTime()`
//    motion value via `useTransform`, so the body and the ball can NEVER drift
//    out of sync (two independent infinite tweens eventually would). The whole
//    choreography is a pure function of loop-progress `p ∈ [0,1)` — see
//    `computeFrame` — which makes every phase boundary continuous (the ball is
//    handed off feet→kick→flight→chest→feet with matching positions at each
//    seam, and the seam back to p=0 lines up too, so the loop is invisible).
//  • It measures the real wordmark. The "TM Code" gradient <span> is taller
//    than the lowercase "Bem-vindo ao" before it, so its cap-top sits one step
//    ABOVE the rest of the line — exactly the "escada" (staircase) the user
//    pointed out. We measure that span every resize and make the runner climb
//    onto it (`groundHigh`) and drop back off (`groundLow`). No hard-coded
//    glyph positions → robust to i18n (PT "Bem-vindo ao" / EN "Welcome to")
//    and font metrics.
//  • Motion values never trigger React re-renders, so this animates on the
//    compositor at 60fps without re-rendering the hero while it streams.
//
// Honours the seasonal kill switch (FOOTBALL_MODE_ENABLED) and OS reduce-motion
// (collapses to a single standing pose), mirroring GoalCelebration.

// ── Tunables ────────────────────────────────────────────────────────────────
const LOOP_MS = 11000 // one full there-and-back cycle (two symmetric halves)
const GAIT_MS = 360 // one running step (leg-swing period)
const SWING_DEG = 26 // leg swing amplitude while running
const ARM_SWING_DEG = 20 // arm counter-swing amplitude
const KICK_LEG_DEG = 78 // how far the kicking leg snaps forward on the strike
const BOB_RATIO = 0.07 // vertical body bob while running (× font size)
const DRIBBLE_RATIO = 0.55 // how far ahead of the feet the ball sits (× font size)
const STEP_DROP_RATIO = 0.2 // lowercase→cap step height (× font size) — the stair

// Phase boundaries inside ONE half (q ∈ [0,1)): run → wind-up → kick+flight → trap+turn.
const RUN_END = 0.56
const KICK_IMPACT = 0.64
const TRAP_MEET = 0.9
const TURN_FROM = 0.45 // within the trap phase, when the pivot to face back begins

const LIMB = tokens.colors.accent.primary
const LIMB_BACK = tokens.colors.accent.primaryDark

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (t: number) => {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}

interface Geom {
  ready: boolean
  unit: number // font size in px — every dimension scales off this
  startX: number // feet x at the left end of the run (≈ start of the text)
  endX: number // feet x at the right end of the run (just past the wordmark)
  stepLeft: number // left edge of the raised wordmark step
  stepRight: number // right edge of the raised wordmark step
  groundLow: number // feet y over the lowercase text (the lower stair)
  groundHigh: number // feet y over the wordmark (the upper stair)
  ramp: number // px over which the stair edge ramps (so the step isn't a teleport)
}

const DEFAULT_GEOM: Geom = {
  ready: false,
  unit: 28,
  startX: 0,
  endX: 0,
  stepLeft: 0,
  stepRight: 0,
  groundLow: 0,
  groundHigh: 0,
  ramp: 0,
}

// Body proportions, all derived from the font size so the runner stays in scale
// whatever the heading is set to.
function dimsOf(unit: number) {
  const stroke = 0.085 * unit
  const ballR = 0.17 * unit
  return {
    unit,
    legLen: 0.32 * unit,
    torsoLen: 0.3 * unit,
    armLen: 0.24 * unit,
    headR: 0.135 * unit,
    stroke,
    torsoW: 1.6 * stroke,
    ballR,
    ballSize: 2 * ballR,
  }
}

// The stepped ground line: low over the lowercase run, high over the wordmark,
// with a short ramp at each edge so the figure visibly steps up/down rather than
// snapping. This is what makes the runner "respect" the tall TM.
function groundOf(x: number, g: Geom): number {
  const { stepLeft, stepRight, groundLow, groundHigh, ramp } = g
  if (ramp <= 0) return x >= stepLeft && x <= stepRight ? groundHigh : groundLow
  if (x <= stepLeft - ramp) return groundLow // before the climb
  if (x < stepLeft) return lerp(groundLow, groundHigh, smooth((x - (stepLeft - ramp)) / ramp)) // up the stair
  if (x <= stepRight) return groundHigh // up on the wordmark (the whole "TM Code")
  if (x < stepRight + ramp) return lerp(groundHigh, groundLow, smooth((x - stepRight) / ramp)) // down the stair
  return groundLow // past the wordmark
}

interface Frame {
  figureX: number
  figureY: number // feet on the (stepped) ground — bob is added later from the clock
  facing: number // +1 right, -1 left, passes through 0 = the turn
  leanDeg: number // torso lean in facing-space (+ = forward)
  kickAmt: number // kicking-leg drive: + forward (strike), − drawn back (wind-up)
  runFactor: number // 1 while jogging, 0 while planted (kick/trap) → fades the gait
  ballX: number
  ballY: number
  ballRot: number
}

// The entire performance as a pure function of loop progress. Kept pure (no
// React, no clock) so the seams are easy to reason about and the static
// reduced-motion pose reuses it. Every phase hands the ball off at a matching
// position, and the two halves mirror so p=1 wraps seamlessly to p=0.
function computeFrame(p: number, g: Geom): Frame {
  const d = dimsOf(g.unit)
  const firstHalf = p < 0.5
  const q = firstHalf ? p / 0.5 : (p - 0.5) / 0.5
  const dir = firstHalf ? 1 : -1
  const A = firstHalf ? g.startX : g.endX // run from here…
  const B = firstHalf ? g.endX : g.startX // …to here (the kick spot)
  const chestH = d.legLen + 0.62 * d.torsoLen // chest height above the feet
  const ballR = d.ballR
  const DRIBBLE = DRIBBLE_RATIO * g.unit

  let feetX: number
  let facing: number
  let leanDeg: number
  let kickAmt: number
  let runFactor: number
  let ballX: number
  let ballY: number
  let ballRot: number

  if (q <= RUN_END) {
    // Jog across, dribbling the ball just ahead; both ride the stepped ground.
    const t = smooth(q / RUN_END)
    feetX = lerp(A, B, t)
    facing = dir
    leanDeg = 7
    kickAmt = 0
    runFactor = 1
    ballX = feetX + dir * DRIBBLE
    const bounce = Math.abs(Math.sin(t * Math.PI * 7)) * (0.22 * g.unit)
    ballY = groundOf(ballX, g) - ballR - bounce
    ballRot = dir * t * 900
  } else if (q <= KICK_IMPACT) {
    // Plant and draw the kicking leg back; ball waits at the dribble spot.
    const u = (q - RUN_END) / (KICK_IMPACT - RUN_END)
    feetX = B
    facing = dir
    leanDeg = lerp(7, -6, u)
    kickAmt = -0.6 * u
    runFactor = 1 - u
    ballX = B + dir * DRIBBLE
    ballY = groundOf(ballX, g) - ballR
    ballRot = dir * 900
  } else if (q <= TRAP_MEET) {
    // Strike, then the ball arcs out and boomerangs back up to the chest.
    const f = (q - KICK_IMPACT) / (TRAP_MEET - KICK_IMPACT)
    feetX = B
    facing = dir
    kickAmt = Math.max(0, 1 - f * 3) // leg snaps forward on contact, recovers fast
    leanDeg = lerp(-6, 4, clamp01(f * 2))
    runFactor = 0
    const reach = 0.12 * (g.endX - g.startX) + 0.3 * g.unit
    const base = B + dir * DRIBBLE
    ballX = base + dir * reach * Math.sin(f * Math.PI) - dir * DRIBBLE * f // f=0→dribble spot, f=1→above feet
    const ground = groundOf(B, g)
    const apex = 0.65 * g.unit + chestH * 0.3
    const arc = 4 * apex * f * (1 - f) // up-and-over parabola, 0 at both ends
    const toChest = chestH * smooth((f - 0.5) / 0.5) // lift to chest over the back half
    ballY = ground - ballR - arc - toChest
    ballRot = dir * 900 + dir * f * 720
  } else {
    // Cushion on the chest, let it drop to the feet, and pivot to run back.
    const r = (q - TRAP_MEET) / (1 - TRAP_MEET)
    feetX = B
    facing = lerp(dir, -dir, smooth((r - TURN_FROM) / (1 - TURN_FROM)))
    leanDeg = -8 * Math.sin(clamp01(r / 0.5) * Math.PI)
    kickAmt = 0
    runFactor = 0
    const ground = groundOf(B, g)
    const chestY = ground - ballR - chestH
    const newDir = -dir
    ballX = lerp(B, B + newDir * DRIBBLE, smooth(clamp01((r - 0.25) / 0.75)))
    const targetY = groundOf(ballX, g) - ballR
    ballY = r < 0.22 ? chestY : lerp(chestY, targetY, smooth((r - 0.22) / 0.78))
    ballRot = dir * 900
  }

  return { figureX: feetX, figureY: groundOf(feetX, g), facing, leanDeg, kickAmt, runFactor, ballX, ballY, ballRot }
}

interface WelcomeRunnerProps {
  /** The relatively-positioned wrapper around the heading the runner overlays. */
  containerRef: React.RefObject<HTMLElement | null>
  /** The "TM Code" wordmark span — the raised stair the runner climbs over. */
  stepRef: React.RefObject<HTMLElement | null>
}

export function WelcomeRunner({ containerRef, stepRef }: WelcomeRunnerProps) {
  // Module-constant gate — safe to early-return before hooks (never flips for a
  // mounted instance).
  if (!FOOTBALL_MODE_ENABLED) return null
  return <Runner containerRef={containerRef} stepRef={stepRef} />
}

function Runner({ containerRef, stepRef }: WelcomeRunnerProps) {
  const reduced = !!useReducedMotion()
  const [geom, setGeom] = useState<Geom>(DEFAULT_GEOM)
  // Mirror of geom that the per-frame transforms read — they must see the latest
  // geometry without being re-created on resize, so they read this ref, not the
  // state closure.
  const geomRef = useRef<Geom>(DEFAULT_GEOM)

  const measure = useCallback(() => {
    const c = containerRef.current
    const s = stepRef.current
    if (!c || !s) return
    const cr = c.getBoundingClientRect()
    const sr = s.getBoundingClientRect()
    if (cr.width === 0 || sr.width === 0) return
    const unit = parseFloat(getComputedStyle(s).fontSize) || 28
    const groundHigh = sr.top - cr.top // cap-top of the wordmark = the upper stair
    const next: Geom = {
      ready: true,
      unit,
      // Turn-around points are the title's outer letters: the "B" of "Bem-vindo"
      // (left, on the lower ground) and the "e" of "Code" (right, up on the
      // wordmark). Feet are nudged inward so they sit ON the glyph, not past it.
      startX: 0.3 * unit,
      endX: sr.right - cr.left - 0.25 * unit,
      stepLeft: sr.left - cr.left,
      stepRight: sr.right - cr.left,
      groundHigh,
      groundLow: groundHigh + STEP_DROP_RATIO * unit,
      ramp: 0.6 * unit,
    }
    geomRef.current = next
    setGeom((prev) =>
      prev.ready &&
      prev.unit === next.unit &&
      prev.startX === next.startX &&
      prev.endX === next.endX &&
      prev.stepLeft === next.stepLeft &&
      prev.groundHigh === next.groundHigh
        ? prev
        : next,
    )
  }, [containerRef, stepRef])

  useLayoutEffect(() => {
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (ro) {
      if (containerRef.current) ro.observe(containerRef.current)
      if (stepRef.current) ro.observe(stepRef.current)
    }
    window.addEventListener('resize', measure)
    // Web fonts can land after first paint and shift the wordmark — re-measure.
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts
    fonts?.ready?.then(measure).catch(() => {})
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, containerRef, stepRef])

  // ── One clock → every animated value ──────────────────────────────────────
  // Everything is a single-input transform of either the loop `frame` (which is
  // itself a transform of the clock) or the raw clock `time`. The leg/arm gait
  // is fast and would need a second input, so those re-derive the frame from
  // `time` instead of taking [frame, gait] — keeps every transform single-input
  // (simpler + sidesteps tuple typing) for a handful of cheap recomputes.
  const time = useTime()
  const progress = useTransform(time, (t) => (t % LOOP_MS) / LOOP_MS)
  const frame = useTransform(progress, (p) => computeFrame(p, geomRef.current))
  const gaitOf = (t: number) => Math.sin((t / GAIT_MS) * Math.PI * 2)

  const figureX = useTransform(frame, (f: Frame) => f.figureX)
  const figureY = useTransform(time, (t) => {
    const f = computeFrame((t % LOOP_MS) / LOOP_MS, geomRef.current)
    const a = (t / GAIT_MS) * Math.PI * 2
    const bob = f.runFactor * BOB_RATIO * geomRef.current.unit * (0.5 - 0.5 * Math.cos(2 * a))
    return f.figureY - bob
  })
  const facing = useTransform(frame, (f: Frame) => f.facing)
  const lean = useTransform(frame, (f: Frame) => f.leanDeg)
  const legFront = useTransform(time, (t) => {
    const f = computeFrame((t % LOOP_MS) / LOOP_MS, geomRef.current)
    return f.runFactor * gaitOf(t) * SWING_DEG + f.kickAmt * KICK_LEG_DEG
  })
  const legBack = useTransform(time, (t) => {
    const f = computeFrame((t % LOOP_MS) / LOOP_MS, geomRef.current)
    return -f.runFactor * gaitOf(t) * SWING_DEG * 0.9
  })
  const arm = useTransform(time, (t) => {
    const f = computeFrame((t % LOOP_MS) / LOOP_MS, geomRef.current)
    return -f.runFactor * gaitOf(t) * ARM_SWING_DEG
  })
  const ballLeft = useTransform(frame, (f: Frame) => f.ballX - dimsOf(geomRef.current.unit).ballR)
  const ballTop = useTransform(frame, (f: Frame) => f.ballY - dimsOf(geomRef.current.unit).ballR)
  const ballRot = useTransform(frame, (f: Frame) => f.ballRot)

  const d = dimsOf(geom.unit)

  // Static pose for the reduced-motion fallback — always computed (cheap + pure)
  // so the fallback args below never deref null when motion IS enabled.
  const still = computeFrame(0, geom)
  const sx = <T,>(mv: MotionValue<T>, fallback: T): MotionValue<T> | T => (reduced ? fallback : mv)

  if (!geom.ready) return null

  const limb = (
    rotate: MotionValue<number> | number,
    opts: { top: number; height: number; width?: number; color?: string; origin?: string; left?: number },
  ) => (
    <motion.div
      style={{
        position: 'absolute',
        left: opts.left ?? -(opts.width ?? d.stroke) / 2,
        top: opts.top,
        width: opts.width ?? d.stroke,
        height: opts.height,
        borderRadius: d.stroke,
        background: opts.color ?? LIMB,
        transformOrigin: opts.origin ?? 'top center',
        rotate,
      }}
    />
  )

  return (
    <Box position="absolute" inset={0} overflow="visible" pointerEvents="none" zIndex={1} aria-hidden>
      {/* Figure — translated to the feet point; an inner wrapper flips it to face
          its running direction (scaleX through 0 reads as the turn). */}
      <motion.div
        style={{ position: 'absolute', left: 0, top: 0, x: sx(figureX, still.figureX), y: sx(figureY, still.figureY), willChange: 'transform' }}
      >
        {/* Ground shadow — sits at the feet, doesn't flip with facing. */}
        <Box
          position="absolute"
          left={`${-d.legLen * 0.7}px`}
          top={`${-d.stroke * 0.3}px`}
          width={`${d.legLen * 1.4}px`}
          height={`${d.stroke * 1.1}px`}
          bg="rgba(0,0,0,0.28)"
          borderRadius="full"
          filter="blur(1px)"
        />
        <motion.div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', scaleX: sx(facing, still.facing) }}>
          {/* back leg (darker, behind) */}
          {limb(sx(legBack, 0), { top: -d.legLen, height: d.legLen, color: LIMB_BACK })}
          {/* torso group — leans around the hip; carries head + arm */}
          <motion.div
            style={{
              position: 'absolute',
              left: -d.torsoW / 2,
              top: -(d.legLen + d.torsoLen),
              width: d.torsoW,
              height: d.torsoLen,
              borderRadius: d.torsoW,
              background: LIMB,
              transformOrigin: 'bottom center',
              rotate: sx(lean, still.leanDeg),
            }}
          >
            {/* head */}
            <Box
              position="absolute"
              left="50%"
              top={`${-2 * d.headR}px`}
              ml={`${-d.headR}px`}
              width={`${2 * d.headR}px`}
              height={`${2 * d.headR}px`}
              borderRadius="full"
              bg={LIMB}
            />
            {/* arm — swings from the shoulder */}
            {limb(sx(arm, 8), { top: 0, height: d.armLen, left: -d.stroke / 2, origin: 'top center' })}
          </motion.div>
          {/* front leg (over the torso) */}
          {limb(sx(legFront, 0), { top: -d.legLen, height: d.legLen })}
        </motion.div>
      </motion.div>

      {/* Ball — independent of the figure (its own world-space position + spin). */}
      <motion.div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          x: sx(ballLeft, still.ballX - d.ballR),
          y: sx(ballTop, still.ballY - d.ballR),
          rotate: sx(ballRot, 0),
          width: d.ballSize,
          height: d.ballSize,
          willChange: 'transform',
        }}
      >
        <FootballMark size={d.ballSize} glow={false} />
      </motion.div>
    </Box>
  )
}
