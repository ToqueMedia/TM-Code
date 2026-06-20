import { useEffect } from 'react'
import { useBillingStore } from '@/stores/billingStore'
import { startCollabSession, stopCollabSession } from '@/services/collab/collabSessionService'

/**
 * Drives the team collaboration session lifecycle: connect to the team's
 * signaling room while the user belongs to a team, disconnect otherwise.
 * Mounted once (MainLayout). Connecting is best-effort — if the signaling
 * worker is unreachable the failure is silent and the rest of the app is
 * unaffected.
 */
export function useCollabSession(): void {
  const teamMemberOf = useBillingStore((s) => s.teamMemberOf)

  useEffect(() => {
    if (teamMemberOf) {
      void startCollabSession()
    } else {
      stopCollabSession()
    }
  }, [teamMemberOf])

  // Tear down on unmount (app close / window teardown).
  useEffect(() => () => stopCollabSession(), [])
}
