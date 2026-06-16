import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { useCelebrationStore } from '@/stores/celebrationStore'
import {
  FOOTBALL_MODE_ENABLED,
  GOAL_BURST_MS,
  GOAL_CONFETTI_COLORS,
  prefersReducedMotion,
} from '@/utils/worldCup'
import { FootballMark } from './FootballMark'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const MotionBox = motion.create(Box)
const MotionText = motion.create(Text)

const CONFETTI_COUNT = 42

interface ConfettiPiece {
  id: number
  x: number
  y: number
  rot: number
  color: string
  w: number
  h: number
  delay: number
  dur: number
  round: boolean
}

// Confetti origin is the centre of the stage; each piece flies out on a random
// vector biased downward (gravity) and fades near the end. Generated once per
// burst (keyed by token) — runtime Math.random is fine here (this is app code,
// not a deterministic workflow script).
function buildConfetti(token: number): ConfettiPiece[] {
  return Array.from({ length: CONFETTI_COUNT }, (_, i) => {
    const angle = Math.random() * Math.PI * 2
    const dist = 90 + Math.random() * 230
    return {
      id: token * 1000 + i,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist * 0.65 + 70 + Math.random() * 150, // gravity bias
      rot: Math.random() * 720 - 360,
      color: GOAL_CONFETTI_COLORS[i % GOAL_CONFETTI_COLORS.length],
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 10,
      delay: Math.random() * 0.12,
      dur: 1 + Math.random() * 0.5,
      round: Math.random() < 0.3,
    }
  })
}

/**
 * Full-surface goal celebration overlay. Mounts once per surface (chat /
 * welcome) and plays a ~1.6s burst whenever `goalToken` changes AFTER mount —
 * the value present at mount is captured and skipped so a stale token from an
 * earlier surface never replays here. Pointer-events: none, so it never blocks
 * the UI underneath. Respects prefers-reduced-motion (static badge, no motion).
 *
 * Positioning: absolute inset-0 — the nearest positioned ancestor must contain
 * it, so the host (ChatView / WelcomeHero root) sets position="relative".
 */
export const GoalCelebration = memo(function GoalCelebration() {
  const goalToken = useCelebrationStore((s) => s.goalToken)
  const goalAt = useCelebrationStore((s) => s.goalAt)
  // Token value at mount — normally "nothing new to play". The exception is a
  // FRESH token (see the effect): a surface mounting in the same tick a goal
  // fired must still play it.
  const mountTokenRef = useRef(goalToken)
  const [burst, setBurst] = useState<{ token: number } | null>(null)

  useEffect(() => {
    if (!FOOTBALL_MODE_ENABLED) return
    // Skip the token already present at mount — a stale leftover from an earlier
    // surface must not replay here. EXCEPTION: if it was triggered within the
    // burst window, this surface mounted in the SAME tick the goal fired (e.g.
    // the Preview pane auto-opening at agent-stop), so play it instead of losing
    // the burst to the mount race.
    if (goalToken === mountTokenRef.current) {
      const justFired = goalToken > 0 && Date.now() - goalAt < GOAL_BURST_MS
      if (!justFired) return
    }
    setBurst({ token: goalToken })
    const ms = prefersReducedMotion() ? 1200 : GOAL_BURST_MS
    const timer = setTimeout(() => setBurst(null), ms)
    return () => clearTimeout(timer)
  }, [goalToken, goalAt])

  // Confetti is generated once per burst (keyed by token) so the random layout
  // stays frozen for the whole animation — without this, a host re-render
  // (ChatView re-renders constantly while streaming) would regenerate the
  // pieces mid-flight and make the confetti visibly jump.
  const pieces = useMemo(() => (burst ? buildConfetti(burst.token) : []), [burst?.token])

  if (!FOOTBALL_MODE_ENABLED) return null

  const reduced = prefersReducedMotion()
  const label = t('celebration.goal')

  return (
    <Box
      position="absolute"
      inset={0}
      overflow="hidden"
      pointerEvents="none"
      zIndex={tokens.zIndex.overlay}
      aria-hidden
    >
      <AnimatePresence>
        {burst && reduced && (
          <Box
            key={`static-${burst.token}`}
            position="absolute"
            top="42%"
            left="50%"
            transform="translate(-50%, -50%)"
            display="flex"
            alignItems="center"
            gap={3}
            px={5}
            py={3}
            borderRadius="full"
            bg={tokens.colors.bg.overlay}
            border={`1px solid ${tokens.colors.accent.primaryMuted}`}
            boxShadow={tokens.shadow.logoGlow}
          >
            <FootballMark size={32} />
            <Text
              fontSize="28px"
              fontWeight="800"
              letterSpacing="0.04em"
              style={{
                background: tokens.gradient.heroTitle,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              {label}
            </Text>
          </Box>
        )}

        {burst && !reduced && (
          <MotionBox
            key={`burst-${burst.token}`}
            position="absolute"
            inset={0}
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <FullBurst label={label} pieces={pieces} />
          </MotionBox>
        )}
      </AnimatePresence>
    </Box>
  )
})

// The animated stage. Kept as a child keyed by token so every burst is a fresh
// mount (framer replays initial→animate from scratch). All motion is anchored
// to a zero-size point at 42%/50% of the overlay.
function FullBurst({ label, pieces }: { label: string; pieces: ConfettiPiece[] }) {
  return (
    <Box position="absolute" top="42%" left="50%" w="0" h="0">
      {/* Impact shock-ring — reads as the "net ripple". */}
      <MotionBox
        position="absolute"
        left="0"
        top="0"
        w="120px"
        h="120px"
        ml="-60px"
        mt="-60px"
        borderRadius="full"
        border={`2px solid ${tokens.colors.accent.primaryMuted}`}
        initial={{ scale: 0.2, opacity: 0.6 }}
        animate={{ scale: 2.4, opacity: 0 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      />

      {/* Radial flash behind the word. */}
      <MotionBox
        position="absolute"
        left="0"
        top="0"
        w="320px"
        h="320px"
        ml="-160px"
        mt="-160px"
        borderRadius="full"
        bg={`radial-gradient(circle, ${tokens.colors.accent.primaryGlow} 0%, transparent 65%)`}
        initial={{ scale: 0.4, opacity: 0.5 }}
        animate={{ scale: 1.3, opacity: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />

      {/* Ball — shot up into frame with a spin and a small settle bounce. */}
      <MotionBox
        position="absolute"
        left="0"
        top="0"
        ml="-26px"
        initial={{ y: 190, scale: 0.7, opacity: 0, rotate: 0 }}
        animate={{ y: [-78, -58, -64], scale: 1, opacity: 1, rotate: 720 }}
        transition={{ duration: 0.6, ease: [0.2, 0.85, 0.3, 1], times: [0, 0.75, 1] }}
      >
        <FootballMark size={52} />
      </MotionBox>

      {/* GOOOAL! — bounce-scale in, gradient fill. */}
      <MotionText
        position="absolute"
        left="0"
        top="0"
        transform="translate(-50%, -50%)"
        whiteSpace="nowrap"
        fontSize="52px"
        fontWeight="800"
        letterSpacing="0.04em"
        textShadow="0 4px 24px rgba(254, 16, 99, 0.4)"
        style={{
          background: tokens.gradient.heroTitle,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: [0.4, 1.15, 1], opacity: [0, 1, 1] }}
        transition={{ duration: 0.5, ease: 'easeOut', times: [0, 0.6, 1] }}
      >
        {label}
      </MotionText>

      {/* Confetti — radiate from the centre point. */}
      {pieces.map((p) => (
        <MotionBox
          key={p.id}
          position="absolute"
          left="0"
          top="0"
          w={`${p.w}px`}
          h={`${p.h}px`}
          bg={p.color}
          borderRadius={p.round ? 'full' : '1px'}
          initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
          animate={{ x: p.x, y: p.y, rotate: p.rot, opacity: [1, 1, 0] }}
          transition={{ duration: p.dur, delay: p.delay, ease: 'easeOut', times: [0, 0.65, 1] }}
        />
      ))}
    </Box>
  )
}
