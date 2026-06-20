// Live Preview host (SHARER side orchestration).
//
// Activating Live Preview always spins up a DEDICATED dev server on port 7773
// (independent of the Chat preview server — both can run at once), headless,
// then advertises it to the team over the tunnel. Stopping the share (anywhere)
// kills that 7773 server; see stopLivePreview in collabSessionService.

import { useCollabStore } from '@/stores/collabStore'
import { useToastStore } from '@/stores/toastStore'
import { shareLivePreview } from '@/services/collab/collabSessionService'
import { startLivePreviewServer, stopLivePreviewServer } from '@/services/collab/livePreviewServer'
import { t } from '@/i18n'

export { LIVE_PREVIEW_PORT } from '@/services/collab/livePreviewServer'

function toast(type: 'info' | 'success' | 'warning' | 'error', message: string): void {
  useToastStore.getState().addToast(type, message)
}

/**
 * Start the dedicated 7773 dev server (headless) and share it with the team.
 * Always forces port 7773 and leaves the Chat preview server (if any) running.
 */
export async function startAndShareLivePreview(projectPath: string | null): Promise<void> {
  const store = useCollabStore.getState()
  if (store.sharingPreview || store.startingPreview) return
  if (!projectPath) {
    toast('error', t('team.noDevCommand'))
    return
  }

  // Single-sharer lock — only one teammate may share at a time (the
  // simultaneous-start race is broken in collabSessionService by yielding to
  // the lower uid).
  const others = store.livePreviews
  if (others.length > 0) {
    toast('warning', t('team.alreadySharing').replace('{name}', others[0].name))
    return
  }

  store.setStartingPreview(true)
  try {
    // Generic — the strategy (build a static SPA vs start the dev server for a
    // fullstack/backend app) is decided inside startLivePreviewServer.
    toast('info', t('team.startingPreview'))
    const port = await startLivePreviewServer(projectPath)
    // If advertising fails (e.g. the mesh dropped), don't leave the dedicated
    // 7773 static server orphaned + the UI stuck "not live".
    if (!shareLivePreview(port)) {
      await stopLivePreviewServer()
    }
  } catch (e) {
    const code = (e as Error)?.message
    if (code === 'no-dev-command') toast('error', t('team.noDevCommand'))
    else if (code === 'no-build-command') toast('error', t('team.noBuildCommand'))
    else if (code === 'build-failed') toast('error', t('team.buildFailed'))
    else if (code === 'no-build-output') toast('error', t('team.noBuildOutput'))
    else if (code === 'timeout') toast('error', t('team.previewServerTimeout'))
    else toast('error', t('team.previewServerFailed').replace('{error}', String(code ?? e)))
  } finally {
    useCollabStore.getState().setStartingPreview(false)
  }
}
