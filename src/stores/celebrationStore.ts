import { create } from 'zustand'
import { FOOTBALL_MODE_ENABLED } from '@/utils/worldCup'

// celebrationStore — the cross-surface bridge for the seasonal goal burst.
//
// Service code (the agent loop) and React surfaces (chat/welcome/terminal)
// don't share a render tree, so the trigger lives in a tiny store: the agent
// loop bumps `goalToken`, and whichever celebration overlay is currently
// mounted replays its animation when the token changes. A monotonically
// increasing number (not a boolean) means back-to-back goals each retrigger —
// a boolean would coalesce two quick completions into one burst.

interface CelebrationState {
  /** Increments on every celebration request. Overlays subscribe and play. */
  goalToken: number
  /** Wall-clock (ms) of the most recent trigger. Lets a surface that MOUNTS in
   *  the same tick the goal fired — e.g. the Preview pane auto-opening at
   *  agent-stop — tell a fresh celebration from a stale leftover token and play
   *  it anyway, instead of skipping it as "already present at mount". */
  goalAt: number
  /** Tag of the most recent trigger (telemetry / aria), e.g. 'agent_run_complete'. */
  lastReason: string | null
  celebrateGoal: (reason?: string) => void
}

export const useCelebrationStore = create<CelebrationState>((set) => ({
  goalToken: 0,
  goalAt: 0,
  lastReason: null,
  celebrateGoal: (reason) =>
    set((s) => ({ goalToken: s.goalToken + 1, goalAt: Date.now(), lastReason: reason ?? null })),
}))

/**
 * Fire a goal celebration unless the seasonal feature is disabled. Safe to call
 * from non-React code (the agent loop's onDone, the welcome kick-off). Gating
 * here keeps every call site a one-liner and guarantees a single off switch.
 */
export function triggerGoalCelebration(reason?: string): void {
  if (!FOOTBALL_MODE_ENABLED) return
  useCelebrationStore.getState().celebrateGoal(reason)
}

// Dev/QA affordance: fire the celebration on demand from the DevTools console
// (`__tmGoalCelebration()`), so the seasonal burst can be seen on the active
// surface without completing a full agent run. DevTools is enabled even in
// release builds here, and this is inert unless explicitly called — so it is
// intentionally not env-gated.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __tmGoalCelebration?: () => void }).__tmGoalCelebration =
    () => triggerGoalCelebration('manual_test')
}
