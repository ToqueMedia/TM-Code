/**
 * Time Manipulation Guard — detects clock rollback and blocks billing abuse.
 *
 * Strategy:
 * 1. On every billing check, store the current system time + cycleEnd in localStorage
 *    (keyed by device fingerprint).
 * 2. On next check, if current time < stored timestamp → clock was set back.
 * 3. If clock rollback detected:
 *    - Paid plan → downgrade to explorer
 *    - Explorer plan → add explorer tokens, block reset
 *    - Block monthly reset to prevent further abuse
 */

import { logger } from '../utils/logger'

const STORAGE_KEY_PREFIX = 'tm-time-guard:'
const EXPLORER_TOKEN_BUDGET = 1_500_000 // 1.5M tokens

interface TimeGuardState {
  lastCheckTimestamp: number   // Unix ms of last billing check
  lastCycleEnd: string         // "YYYY-MM-DD" from last check
  resetBlocked: boolean        // True if monthly reset is blocked due to time manipulation
  detectedAt: number | null    // When manipulation was first detected
}

function storageKey(fingerprint: string): string {
  return `${STORAGE_KEY_PREFIX}${fingerprint}`
}

/**
 * Load the time guard state from localStorage.
 */
export function loadTimeGuardState(fingerprint: string): TimeGuardState | null {
  try {
    const raw = localStorage.getItem(storageKey(fingerprint))
    if (!raw) return null
    return JSON.parse(raw) as TimeGuardState
  } catch {
    return null
  }
}

/**
 * Save the time guard state to localStorage.
 */
function saveTimeGuardState(fingerprint: string, state: TimeGuardState): void {
  try {
    localStorage.setItem(storageKey(fingerprint), JSON.stringify(state))
  } catch {
    // localStorage full or unavailable — fail open
  }
}

/**
 * Check for time manipulation and update the guard state.
 *
 * @returns `{ manipulated: true, downgradeToExplorer: true }` if clock rollback
 *          was detected and the caller should downgrade the user.
 */
export function checkTimeManipulation(
  fingerprint: string,
  currentPlan: string,
  currentCycleEnd: string,
): { manipulated: boolean; downgradeToExplorer: boolean; blockReset: boolean } {
  const now = Date.now()
  const prev = loadTimeGuardState(fingerprint)

  // First run — no previous state, just record and allow.
  if (!prev) {
    saveTimeGuardState(fingerprint, {
      lastCheckTimestamp: now,
      lastCycleEnd: currentCycleEnd,
      resetBlocked: false,
      detectedAt: null,
    })
    return { manipulated: false, downgradeToExplorer: false, blockReset: false }
  }

  // If reset was already blocked from a previous detection, enforce it.
  if (prev.resetBlocked) {
    return {
      manipulated: true,
      downgradeToExplorer: currentPlan !== 'explorer' && currentPlan !== 'welcome',
      blockReset: true,
    }
  }

  // Clock rollback detection: current time is BEFORE the last check timestamp.
  // Allow a small tolerance (5 minutes) for NTP adjustments and DST transitions.
  const TOLERANCE_MS = 5 * 60 * 1000
  const clockWentBackward = now < prev.lastCheckTimestamp - TOLERANCE_MS

  // Cycle end anomaly: current time is BEFORE the previously known cycle end,
  // but the previous check was AFTER that cycle end. This means the user
  // rolled back time to before the cycle reset.
  const cycleAnomaly = prev.lastCycleEnd && currentCycleEnd === prev.lastCycleEnd &&
    now < new Date(prev.lastCycleEnd).getTime() &&
    prev.lastCheckTimestamp >= new Date(prev.lastCycleEnd).getTime()

  // Clock forward detection: current time jumped more than 24 hours ahead of
  // the last check. This catches attempts to skip ahead to bypass monthly
  // token reset. Allow 24h tolerance for normal usage patterns (e.g. user
  // leaves app open overnight).
  const MAX_FORWARD_JUMP_MS = 24 * 60 * 60 * 1000
  const clockWentForward = now > prev.lastCheckTimestamp + MAX_FORWARD_JUMP_MS

  // Cycle end skipped: the current cycle end is DIFFERENT from the previous
  // one, but the previous check was BEFORE the old cycle end. This means
  // the clock jumped past the cycle boundary without the normal flow.
  const cycleEndSkipped = prev.lastCycleEnd &&
    currentCycleEnd !== prev.lastCycleEnd &&
    prev.lastCheckTimestamp < new Date(prev.lastCycleEnd).getTime() &&
    now >= new Date(prev.lastCycleEnd).getTime()

  if (clockWentBackward || cycleAnomaly || clockWentForward || cycleEndSkipped) {
    const reason = clockWentBackward ? 'clock_rollback' :
      clockWentForward ? 'clock_forward' :
      cycleAnomaly ? 'cycle_anomaly' : 'cycle_end_skipped'
    logger.warn('time-guard', `Time manipulation detected (${reason}): now=${now}, prev=${prev.lastCheckTimestamp}, cycleEnd=${currentCycleEnd}`)
    const state: TimeGuardState = {
      lastCheckTimestamp: now,
      lastCycleEnd: currentCycleEnd,
      resetBlocked: true,
      detectedAt: prev.detectedAt ?? now,
    }
    saveTimeGuardState(fingerprint, state)
    return {
      manipulated: true,
      downgradeToExplorer: true, // always downgrade on detection
      blockReset: true,
    }
  }

  // Normal flow — update the guard state.
  saveTimeGuardState(fingerprint, {
    lastCheckTimestamp: now,
    lastCycleEnd: currentCycleEnd,
    resetBlocked: false,
    detectedAt: null,
  })

  return { manipulated: false, downgradeToExplorer: false, blockReset: false }
}

/**
 * Force-block resets for a fingerprint (e.g. when admin detects abuse).
 */
export function blockResets(fingerprint: string): void {
  const prev = loadTimeGuardState(fingerprint)
  saveTimeGuardState(fingerprint, {
    lastCheckTimestamp: Date.now(),
    lastCycleEnd: prev?.lastCycleEnd ?? '',
    resetBlocked: true,
    detectedAt: prev?.detectedAt ?? Date.now(),
  })
}

/**
 * Check if resets are blocked for a fingerprint.
 */
export function isResetBlocked(fingerprint: string): boolean {
  const state = loadTimeGuardState(fingerprint)
  return state?.resetBlocked ?? false
}

export { EXPLORER_TOKEN_BUDGET }
