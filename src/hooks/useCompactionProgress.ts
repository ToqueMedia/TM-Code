// useCompactionProgress — a reassuring progress estimate for context compaction.
//
// Compaction is a single LLM summarization call: the agent loop emits only
// `compact_start` / `compact_end` (see agentRunner onContextCompression), so
// there is NO real percentage to report. Rather than an indeterminate spinner,
// this hook synthesizes a monotonic, time-eased estimate from how long the
// compaction has been running — an asymptotic curve that climbs quickly at
// first and slows as it approaches a ceiling, never stalling and never
// claiming to have measured the summary. It resets when compaction ends (the
// consumer unmounts), so the bar simply disappears on completion.
//
// Active === agentStore.status 'compressing' (set on compact_start, cleared to
// 'awaiting_response' on compact_end).

import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'

// Tuning — purely cosmetic. CEILING caps the synthetic bar below 100% (we never
// fake completion; the bar vanishes when the real compaction ends). TAU_MS is
// the time-constant of the ease: ~63% of the way to the ceiling after one TAU.
const CEILING = 0.95
const TAU_MS = 45_000
const TICK_MS = 250

export interface CompactionProgress {
  active: boolean
  /** 0–95 while active, integer. */
  percent: number
  /** Milliseconds since this compaction started. */
  elapsedMs: number
}

/**
 * Pure synthetic progress: an asymptotic ease from elapsed time to an integer
 * percent in [1, 95]. Monotonic increasing, never reaches 100 (compaction has
 * no real completion signal — the bar disappears when it actually ends).
 * Extracted for testability.
 */
export function compactionPercentForElapsed(elapsedMs: number): number {
  const eased = CEILING * (1 - Math.exp(-Math.max(0, elapsedMs) / TAU_MS))
  return Math.max(1, Math.min(Math.round(CEILING * 100), Math.round(eased * 100)))
}

export function useCompactionProgress(): CompactionProgress {
  const status = useAgentStore(s => s.status)
  const active = status === 'compressing'

  // Re-render on a timer while active so the eased value advances.
  const [, tick] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (!active) {
      startRef.current = 0
      return
    }
    if (startRef.current === 0) startRef.current = Date.now()
    const id = setInterval(() => tick(n => (n + 1) % 1_000_000), TICK_MS)
    return () => clearInterval(id)
  }, [active])

  if (!active || startRef.current === 0) {
    return { active: false, percent: 0, elapsedMs: 0 }
  }

  const elapsedMs = Date.now() - startRef.current
  return { active: true, percent: compactionPercentForElapsed(elapsedMs), elapsedMs }
}

export function formatCompactElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}
