import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'
import { useChatStore } from '../stores/chatStore'
import { usePermissionStore } from '../stores/permissionStore'
import { useCredentialRequestStore } from '../stores/credentialRequestStore'
import { useAskUserQuestionStore } from '../stores/askUserQuestionStore'

/**
 * Elapsed-time ticker for any UI that surfaces "the agent is busy for N seconds".
 *
 * Multiple timers in the app surface this number (AgentStatusBar,
 * AgentActivityIndicator). Without a shared hook the pause-on-permission logic drifted
 * — fixing one left two counting through user wait time, which is a lie since the
 * agent isn't doing work then.
 *
 * Behaviour:
 *  - `mode: 'phase'` resets on every status transition (per-phase clock used by
 *    AgentStatusBar — "12s in awaiting_response" is more useful than total).
 *  - `mode: 'session'` runs from when streaming started (used by the activity
 *    indicator and terminal status — they want total wall time per request).
 *  - **Both modes freeze when the agent is waiting on the user.** Three wait
 *    states qualify:
 *      1. permissionStore.pendingPermission — tool-permission dialog open.
 *      2. credentialRequestStore.pending.size > 0 — request_credentials form
 *         rendered in chat, awaiting submit/skip.
 *      3. chatStore.pendingDiffs.length > 0 — write/edit diff awaiting
 *         approve/reject inline.
 *     In any of these the user is the one working; the agent's wall clock
 *     would lie ("11m 25s applying changes…" while the agent has been
 *     blocked on a credentials form for 8 of those minutes). Freeze the
 *     value during the wait; resume from the same instant.
 */
export function useAgentElapsed(mode: 'phase' | 'session'): {
  elapsedMs: number
  isPaused: boolean
} {
  const status = useAgentStore(s => s.status)
  const isStreaming = useChatStore(s => s.isStreaming)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const pendingCredentialCount = useCredentialRequestStore(s => s.pending.size)
  const pendingQuestionCount = useAskUserQuestionStore(s => s.pending.size)
  const pendingDiffCount = useChatStore(s => s.pendingDiffs.length)

  const isBusy = mode === 'phase'
    ? status !== 'idle' && status !== 'error'
    : isStreaming
  const isPaused = !!pendingPermission || pendingCredentialCount > 0 || pendingQuestionCount > 0 || pendingDiffCount > 0

  const [elapsedMs, setElapsedMs] = useState(0)
  const phaseStartRef = useRef<number>(0)
  const pausedAccumRef = useRef<number>(0)
  const pauseStartRef = useRef<number>(0)

  // Reset the clock on each phase boundary (status change in 'phase' mode,
  // streaming start/stop in 'session' mode).
  const resetKey = mode === 'phase' ? status : (isStreaming ? 'streaming' : 'idle')
  useEffect(() => {
    if (!isBusy) {
      phaseStartRef.current = 0
      pausedAccumRef.current = 0
      pauseStartRef.current = 0
      setElapsedMs(0)
      return
    }
    phaseStartRef.current = Date.now()
    pausedAccumRef.current = 0
    pauseStartRef.current = 0
    setElapsedMs(0)
  }, [isBusy, resetKey])

  // Track pause boundaries — accumulate time spent waiting for the user to
  // approve a tool. The accumulated total is subtracted from elapsed below.
  useEffect(() => {
    if (!isBusy) return
    if (isPaused) {
      if (pauseStartRef.current === 0) pauseStartRef.current = Date.now()
    } else {
      if (pauseStartRef.current > 0) {
        pausedAccumRef.current += Date.now() - pauseStartRef.current
        pauseStartRef.current = 0
      }
    }
  }, [isPaused, isBusy])

  // Tick — skip the state update when paused so the rendered number freezes.
  // Always reads refs so deps stay minimal (no closure staleness).
  useEffect(() => {
    if (!isBusy) return
    const id = setInterval(() => {
      if (pauseStartRef.current > 0) return
      setElapsedMs(Date.now() - phaseStartRef.current - pausedAccumRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [isBusy])

  return { elapsedMs, isPaused }
}
