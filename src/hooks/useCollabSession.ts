import { useEffect } from 'react'
import { useBillingStore } from '@/stores/billingStore'
import { useProjectStore } from '@/stores/projectStore'
import { startCollabSession, stopCollabSession } from '@/services/collab/collabSessionService'

/**
 * Drives the team collaboration session lifecycle: connect to the signaling
 * room for the current TEAM + PROJECT while both exist, disconnect otherwise.
 * Rooms are per-project — a teammate in another project is in another room
 * and never appears online here. Mounted once (MainLayout). Connecting is
 * best-effort — if the signaling worker is unreachable the failure is silent
 * and the rest of the app is unaffected.
 */
export function useCollabSession(): void {
  const teamMemberOf = useBillingStore((s) => s.teamMemberOf)
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null)

  useEffect(() => {
    if (teamMemberOf && projectPath) {
      // Project switches restart the session into the new project's room
      // (startCollabSession is idempotent per room and tears down the old
      // mesh when the room changes).
      void startCollabSession()
    } else {
      stopCollabSession()
    }
  }, [teamMemberOf, projectPath])

  // Tear down on unmount (app close / window teardown).
  useEffect(() => () => stopCollabSession(), [])
}
