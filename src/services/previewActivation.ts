/**
 * Standalone preview/dev-server activation. ChatView and PromptBar share this
 * so preview opening and manual server start use the same detection path.
 */
import { invoke } from '@/utils/invokeMetrics'
import { useLayoutStore, selectIsPreviewServerRunning } from '../stores/layoutStore'
import { useCollabStore } from '../stores/collabStore'
import { useToastStore } from '../stores/toastStore'
import { devServerManager } from './devServerManager'
import { ensureDependenciesInstalled } from './dependencyInstaller'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import { readProjectManifest } from './projectManifestService'
import { pickDevScript } from './devServerDetection'

/**
 * Detect the dev command for a project by checking manifest and package.json.
 */
export async function detectDevCommand(projectPath: string): Promise<string | null> {
  // 1. Check the canonical TM Code project manifest.
  const projectManifest = await readProjectManifest(projectPath)
  if (projectManifest?.capabilities.preview.supported === false) return null
  if (projectManifest?.commands.dev) return projectManifest.commands.dev
  if (projectManifest?.capabilities.preview.command) return projectManifest.capabilities.preview.command

  // 2. Check legacy .toquemedia-template manifest
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/.toquemedia-template` })
    if (raw) {
      const manifest = JSON.parse(raw)
      if (manifest.devCommand) return manifest.devCommand
    }
  } catch { /* no manifest */ }

  // 3. Check package.json — `dev`/`start`, and the `dev:*` variants.
  //
  // Só `dev` e `start` EXACTOS eram reconhecidos, e isso deixava de fora os
  // projectos que chamam ao script `dev:web`, `dev:client` ou `dev:all`. O
  // sintoma era enganador: o botão ficava desligado e a mensagem pedia para
  // adicionar um script `dev` que já lá estava, com outro nome. A escolha
  // entre variantes vive em `pickDevScript` (lógica pura, testada à parte).
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
    if (raw) {
      const pkg = JSON.parse(raw)
      const script = pickDevScript(pkg?.scripts)
      if (script === 'start') return 'npm start'
      if (script) {
        // Uma variante escolhida por heurística tem de ser VISÍVEL: se o
        // preview arrancar a coisa errada, isto é a primeira pista.
        if (script !== 'dev') {
          logger.info('preview', `package.json sem script "dev" — a usar "${script}"`)
        }
        return `npm run ${script}`
      }
    }
  } catch { /* no package.json */ }

  return null
}

interface EnsureDevServerOptions {
  openPreview?: boolean
}

/**
 * Ensure the project's dev server is running. When `openPreview` is true,
 * also switches the layout to Preview; otherwise starts in the background.
 */
export async function ensureDevServerRunning(
  projectPath: string | null,
  options: EnsureDevServerOptions = {},
): Promise<boolean> {
  const openPreview = options.openPreview === true
  const layout = useLayoutStore.getState()

  // Blocked while sharing a team Live Preview: opening the normal preview would
  // start a SECOND dev server for the same project (port collision) and clash
  // with the dedicated Live Preview server (7773). Guard at the source so every
  // entry point (header button, menu, agent tool) is covered.
  if (useCollabStore.getState().sharingPreview) {
    useToastStore.getState().addToast('warning', t('team.previewBlockedBySharing'))
    return false
  }

  // Server already running → optionally switch to preview, but never restart.
  if (selectIsPreviewServerRunning(layout)) {
    if (openPreview) layout.setViewMode('preview')
    return true
  }

  // Server already starting → don't restart.
  if (devServerManager.isActive()) {
    if (openPreview) layout.setViewMode('preview')
    return true
  }

  if (openPreview) {
    // Switch immediately so the user sees the loading state.
    layout.setViewMode('preview')
  }

  if (!projectPath) return false

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
    if (!openPreview) {
      useToastStore.getState().addToast('warning', t('team.noDevCommand'))
    }
    return false
  }

  // One-click contract: a project that was never installed (no node_modules)
  // must still preview from a single click. Install missing dependencies first,
  // streaming progress into the same console the dev server uses, THEN start.
  // No-op (instant) when node_modules already exists.
  useLayoutStore.getState().setPreviewServerLoading(true)
  const ensured = await ensureDependenciesInstalled(projectPath, {
    onInstallStart: () => useLayoutStore.getState().setInstallingDeps(true),
    onLog: (text, level) => useLayoutStore.getState().addDevServerLog(text, level),
  })
  useLayoutStore.getState().setInstallingDeps(false)
  if (ensured.status === 'failed') {
    // Error already logged → the PreviewView surfaces the failure state.
    useLayoutStore.getState().setPreviewServerLoading(false)
    return false
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
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    useLayoutStore.getState().addDevServerLog(`Could not start dev server: ${msg}`, 'error')
    return false
  }
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

  // Static preview does not require a dev server.
  if (layout.previewHtmlContent) {
    layout.setViewMode('preview')
    return
  }

  await ensureDevServerRunning(projectPath, { openPreview: true })
}
