/**
 * Standalone preview activation — detects the dev command, starts the
 * dev server, and switches the layout to preview mode. Extracted from
 * usePromptBar's `togglePreview` so ChatView's header button can
 * trigger the same flow without duplicating detection logic.
 */
import { invoke } from '@/utils/invokeMetrics'
import { useLayoutStore, selectIsPreviewServerRunning } from '../stores/layoutStore'
import { useCollabStore } from '../stores/collabStore'
import { useToastStore } from '../stores/toastStore'
import { devServerManager } from './devServerManager'
import { logger } from '../utils/logger'
import { t } from '../i18n'

/**
 * Detect the dev command for a project by checking manifest and package.json.
 */
export async function detectDevCommand(projectPath: string): Promise<string | null> {
  // 1. Check .toquemedia-template manifest
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/.toquemedia-template` })
    if (raw) {
      const manifest = JSON.parse(raw)
      if (manifest.devCommand) return manifest.devCommand
    }
  } catch { /* no manifest */ }

  // 2. Check package.json for "dev" or "start" script
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
    if (raw) {
      const pkg = JSON.parse(raw)
      if (pkg.scripts?.dev) return 'npm run dev'
      if (pkg.scripts?.start) return 'npm start'
    }
  } catch { /* no package.json */ }

  return null
}

/**
 * Activate the preview for a project:
 *  1. If already in preview mode → do nothing (caller can toggle off via goBack).
 *  2. If server already running or static preview exists → just switch view.
 *  3. Otherwise → detect dev command, start dev server, switch view.
 */
export async function activatePreview(projectPath: string | null): Promise<void> {
  const layout = useLayoutStore.getState()

  // Already in preview — nothing to do (caller handles toggle-off).
  if (layout.viewMode === 'preview') return

  // Blocked while sharing a team Live Preview: opening the normal preview would
  // start a SECOND dev server for the same project (port collision) and clash
  // with the dedicated Live Preview server (7773). Guard at the source so every
  // entry point (header button, menu, agent tool) is covered.
  if (useCollabStore.getState().sharingPreview) {
    useToastStore.getState().addToast('warning', t('team.previewBlockedBySharing'))
    return
  }

  // Server already running or static preview ready → just switch.
  if (selectIsPreviewServerRunning(layout) || layout.previewHtmlContent) {
    layout.setViewMode('preview')
    return
  }

  // Server already starting → don't restart.
  if (devServerManager.isActive()) {
    layout.setViewMode('preview')
    return
  }

  // Switch to preview view immediately so the user sees the loading state.
  layout.setViewMode('preview')

  if (!projectPath) return

  // Detect dev command (just-in-time — detection may not have run yet).
  let cmd: string | null = null
  try {
    cmd = await detectDevCommand(projectPath)
  } catch (err) {
    logger.error('preview-activation', 'dev command detection failed', err)
  }

  if (!cmd) {
    // No dev command found — preview opens with "Waiting..." state.
    // User can ask the agent to set up and start the server.
    return
  }

  const freshLayout = useLayoutStore.getState()
  freshLayout.addDevServerLog(`Starting dev server (${cmd})...`, 'info')

  // Detect project kind (frontend / backend / fullstack).
  let projectKind: 'frontend' | 'backend' | 'fullstack' | undefined
  try {
    const { detectProjectCategory, categoryToServerHint } = await import('./projectTypeDetector')
    const cat = await detectProjectCategory(projectPath)
    projectKind = categoryToServerHint(cat)
  } catch { /* non-fatal — start() defaults to frontend */ }

  try {
    const { resolveFrontendPortHint } = await import('./templateService')
    const frontendPortHint = projectKind
      ? await resolveFrontendPortHint(projectPath, projectKind)
      : undefined
    await devServerManager.start(projectPath, cmd, { projectKind, frontendPortHint })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    useLayoutStore.getState().addDevServerLog(`Could not start dev server: ${msg}`, 'error')
  }
}
