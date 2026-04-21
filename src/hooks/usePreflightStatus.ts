import { useEffect, useSyncExternalStore } from 'react'
import {
  ensurePreflight,
  getPreflightSnapshot,
  subscribeToPreflight,
  type PreflightChecks,
} from '../services/preflightService'

/**
 * Subscribes to the shared preflight cache and triggers the first-run probe
 * when no result is cached yet. Safe to call from multiple components —
 * `ensurePreflight()` deduplicates in-flight calls internally.
 */
export function usePreflightStatus(): PreflightChecks {
  const state = useSyncExternalStore(subscribeToPreflight, getPreflightSnapshot)

  useEffect(() => {
    // Fire and forget — UI updates via the store subscription when probes complete.
    void ensurePreflight()
  }, [])

  return state
}
