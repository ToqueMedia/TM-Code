import { useEffect, useMemo, useRef, useState } from 'react'
import { Box } from '@chakra-ui/react'
import { useCelebrationStore } from '@/stores/celebrationStore'
import { FOOTBALL_MODE_ENABLED, prefersReducedMotion } from '@/utils/worldCup'
import { buildGoalFrames, GOAL_FRAME_INTERVAL_MS } from '../celebration/goalFrames'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'

// Shell-styled goal celebration. Honours the refined-shell contract: a
// monospace, single-accent (purple) overlay that steps through ASCII frames as
// discrete hard-steps — NO framer-motion, NO smooth tween, NO confetti palette
// (those belong to the GUI surfaces). Plays once per goal then clears.
//
// Positioned absolute over the bottom of the scrollback (above the status line
// / prompt), pointer-events none. The host root sets
// position="relative".
export function TerminalGoalCelebration() {
  const t = useTranslation()
  const goalToken = useCelebrationStore((s) => s.goalToken)
  const mountTokenRef = useRef(goalToken)
  const [playing, setPlaying] = useState(false)
  const [frameIdx, setFrameIdx] = useState(0)

  const frames = useMemo(() => buildGoalFrames(t('celebration.goal')), [t])

  useEffect(() => {
    if (!FOOTBALL_MODE_ENABLED) return
    if (goalToken === mountTokenRef.current) return // initial value — nothing new

    // Reduced motion → hold only the final celebratory frame, no stepping.
    if (prefersReducedMotion()) {
      setFrameIdx(frames.length - 1)
      setPlaying(true)
      const tmo = setTimeout(() => setPlaying(false), 1200)
      return () => clearTimeout(tmo)
    }

    setFrameIdx(0)
    setPlaying(true)
    let i = 0
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    const id = setInterval(() => {
      i += 1
      if (i >= frames.length) {
        clearInterval(id)
        // Hold the last frame briefly so the "GOAL" doesn't vanish instantly.
        holdTimer = setTimeout(() => setPlaying(false), 450)
        return
      }
      setFrameIdx(i)
    }, GOAL_FRAME_INTERVAL_MS)

    return () => {
      clearInterval(id)
      if (holdTimer) clearTimeout(holdTimer)
    }
  }, [goalToken, frames])

  if (!FOOTBALL_MODE_ENABLED || !playing) return null

  return (
    <Box
      position="absolute"
      bottom="16px"
      left="50%"
      transform="translateX(-50%)"
      pointerEvents="none"
      zIndex={20}
      px={3}
      py={1.5}
      borderRadius={tokens.radius.sm}
      bg="rgba(10, 10, 10, 0.72)"
      border={`1px solid ${tokens.colors.accent.purpleMuted}`}
      aria-hidden
    >
      <Box
        as="pre"
        m={0}
        fontFamily={tokens.fontFamily.mono}
        fontSize="13px"
        lineHeight="1.4"
        whiteSpace="pre"
        color={tokens.colors.accent.purple}
      >
        {frames[frameIdx] ?? ''}
      </Box>
    </Box>
  )
}
