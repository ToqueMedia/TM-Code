import { useEffect } from 'react'
import { useBillingStore, isTeamCollabActive } from '@/stores/billingStore'
import { startCollabSession, stopCollabSession } from '@/services/collab/collabSessionService'

/**
 * Drives the team collaboration session lifecycle: connect to the TEAM room
 * while the team plan is active, disconnect otherwise. As of v1.0.1 the room is
 * team-level (NOT per-project) — teammates meet regardless of which project each
 * has open, and the session no longer requires an open project at all. It runs
 * on the Welcome screen too. Mounted once (MainLayout).
 *
 * The gate is `isTeamCollabActive` (membership AND non-expired term), so when the
 * team plan lapses and isn't renewed this effect re-runs and tears the session
 * down — presence, chat, voice, screen share and preview sharing all stop.
 * Connecting is best-effort: an unreachable signaling worker fails silently.
 */
export function useCollabSession(): void {
  const canCollaborate = useBillingStore(isTeamCollabActive)

  useEffect(() => {
    if (canCollaborate) {
      // Idempotent per room; a team switch tears down the old mesh first.
      void startCollabSession()
    } else {
      stopCollabSession()
    }
  }, [canCollaborate])

  // Tear down on unmount (app close / window teardown).
  useEffect(() => () => stopCollabSession(), [])
}
