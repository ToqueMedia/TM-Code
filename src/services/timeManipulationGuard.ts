/**
 * Time Manipulation Guard — detects clock rollback and blocks billing abuse.
 *
 * Strategy:
 * 1. On every billing check, store the current system time in localStorage
 *    (keyed by device fingerprint).
 * 2. On next check, if current time < stored timestamp → clock was set back.
 * 3. If clock rollback detected:
 *    - Paid plan → downgrade to explorer
 *    - Block lasts at least MIN_BLOCK_DURATION_MS (server-side enforced)
 *    - Auto-clear only after cooldown + clock is stable
 *
 * Design decisions (v3):
 * - Only backward jumps are detection signals. Forward jumps and cycle-end
 *   changes are normal user behaviour (long sessions, sleep, new month).
 * - Block has a minimum duration to prevent unblock-then-reblock oscillation.
 * - `blockReset` removed — the minimum duration replaces it.
 */

import { logger } from '../utils/logger'

const STORAGE_KEY_PREFIX = 'tm-time-guard:'
const EXPLORER_TOKEN_BUDGET = 1_500_000 // 1.5M tokens
/** Tolerance for small backward clock drift — NTP adjustments, DST, sleep. */
const TOLERANCE_MS = 5 * 60 * 1000 // 5min
/**
 * Minimum block duration: once a manipulation is detected, the block cannot
 * be cleared before this period expires. This prevents the model from
 * oscillating block/unblock when NTP drift hovers near the tolerance
 * boundary. Also gives the backend time to record the block before the
 * client clears it.
 */
const MIN_BLOCK_DURATION_MS = 30 * 60 * 1000 // 30min
/**
 * Cooldown after auto-unblocking: skip manipulation detection for this
 * period to prevent immediate re-detection if the clock drifts again.
 */
const UNBLOCK_COOLDOWN_MS = 60 * 60 * 1000 // 1h

interface TimeGuardState {
  lastCheckTimestamp: number   // Unix ms of last billing check
  detectedAt: number | null    // When manipulation was first detected
  unblockedAt: number | null   // When the block was auto-cleared (for cooldown)
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
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Migrate: strip legacy fields that no longer exist
    return {
      lastCheckTimestamp: parsed.lastCheckTimestamp as number,
      detectedAt: (parsed.detectedAt as number | null) ?? null,
      unblockedAt: (parsed.unblockedAt as number | null) ?? null,
    }
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
 * Only detects backward clock jumps (clock set back). Forward jumps and
 * cycle-end changes are NOT signals — users leave apps open overnight,
 * hibernate laptops, and cycles change naturally.
 */
export function checkTimeManipulation(
  fingerprint: string,
): { manipulated: boolean; downgradeToExplorer: boolean } {
  const now = Date.now()
  const prev = loadTimeGuardState(fingerprint)

  // First run — no previous state, just record and allow.
  if (!prev) {
    saveTimeGuardState(fingerprint, {
      lastCheckTimestamp: now,
      detectedAt: null,
      unblockedAt: null,
    })
    return { manipulated: false, downgradeToExplorer: false }
  }

  // Cooldown: if the block was recently cleared, skip manipulation detection
  // for UNBLOCK_COOLDOWN_MS to prevent NTP oscillation cycles.
  if (prev.unblockedAt && now - prev.unblockedAt < UNBLOCK_COOLDOWN_MS) {
    saveTimeGuardState(fingerprint, {
      lastCheckTimestamp: now,
      detectedAt: null,
      unblockedAt: prev.unblockedAt,
    })
    return { manipulated: false, downgradeToExplorer: false }
  }

  // If a block was previously detected, check if it should auto-clear.
  if (prev.detectedAt) {
    // Minimum block duration: don't unblock before MIN_BLOCK_DURATION_MS
    const blockAge = now - prev.detectedAt
    if (blockAge < MIN_BLOCK_DURATION_MS) {
      // Still within minimum block window — enforce block, don't re-evaluate
      return {
        manipulated: true,
        downgradeToExplorer: true,
      }
    }

    // Minimum duration elapsed — re-verify the clock.
    // If it's now within tolerance, auto-clear the block.
    const stillRolledBack = now < prev.lastCheckTimestamp - TOLERANCE_MS
    if (!stillRolledBack) {
      // Clock is reasonable — clear the block.
      logger.warn('time-guard', 'Block auto-cleared — clock is now within tolerance')
      saveTimeGuardState(fingerprint, {
        lastCheckTimestamp: now,
        detectedAt: null,
        unblockedAt: now,
      })
      return { manipulated: false, downgradeToExplorer: false }
    }

    // Clock is still unreasonable — continue blocking.
    return {
      manipulated: true,
      downgradeToExplorer: true,
    }
  }

  // Clock rollback detection: current time is BEFORE the last check timestamp.
  // Allow a small tolerance (5 minutes) for NTP adjustments and DST transitions.
  const clockWentBackward = now < prev.lastCheckTimestamp - TOLERANCE_MS

  if (clockWentBackward) {
    logger.warn('time-guard', `Clock rollback detected: now=${now}, prev=${prev.lastCheckTimestamp}`)
    saveTimeGuardState(fingerprint, {
      lastCheckTimestamp: now,
      detectedAt: now,
      unblockedAt: null,
    })
    return {
      manipulated: true,
      downgradeToExplorer: true,
    }
  }

  // Normal flow — update the guard state.
  const cooldownExpired = !prev.unblockedAt || (now - prev.unblockedAt >= UNBLOCK_COOLDOWN_MS)
  saveTimeGuardState(fingerprint, {
    lastCheckTimestamp: now,
    detectedAt: null,
    unblockedAt: cooldownExpired ? null : prev.unblockedAt,
  })

  return { manipulated: false, downgradeToExplorer: false }
}

/**
 * Force-block a fingerprint (e.g. when admin detects abuse server-side).
 */
export function blockResets(fingerprint: string): void {
  const prev = loadTimeGuardState(fingerprint)
  saveTimeGuardState(fingerprint, {
    lastCheckTimestamp: Date.now(),
    detectedAt: prev?.detectedAt ?? Date.now(),
    unblockedAt: null,
  })
}

/**
 * Check if a fingerprint is currently blocked.
 */
export function isResetBlocked(fingerprint: string): boolean {
  const state = loadTimeGuardState(fingerprint)
  return state?.detectedAt != null
}

export { EXPLORER_TOKEN_BUDGET }
