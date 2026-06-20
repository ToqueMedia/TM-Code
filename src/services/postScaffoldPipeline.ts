import { t } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { useLayoutStore } from '../stores/layoutStore'
import { devServerManager } from './devServerManager'
import { templateService, Template, resolveFrontendPortHint } from './templateService'
import { detectSystemPackageManager, adaptCommand } from './packageManagerDetector'
import { runStreamingInstall } from './dependencyInstaller'
import { logger } from '../utils/logger'

/**
 * Full scaffold flow: copy template → open project → create session → run pipeline.
 * Shared by WelcomeScreen and MainLayout to avoid duplication.
 */
export async function setupScaffoldedProject(
  template: Template,
  projectPath: string,
): Promise<void> {
  await templateService.scaffold(template.id, projectPath)
  await useProjectStore.getState().openProject(projectPath)

  postScaffoldPipeline(projectPath, template)
    .catch(err => logger.error('scaffold', 'Post-scaffold pipeline failed:', err))
}

/**
 * Orchestrates the post-scaffold flow:
 * 1. Install dependencies
 * 2. Start dev server
 * 3. Auto-transition to preview when URL is detected
 */
async function postScaffoldPipeline(
  projectPath: string,
  template: Template,
): Promise<void> {
  const layoutStore = useLayoutStore.getState()

  // Detect the fastest available PM and adapt template commands
  const pm = await detectSystemPackageManager()
  const installCmd = adaptCommand(template.installCommand, pm)
  const devCmd = adaptCommand(template.devCommand, pm)

  // === Phase 1: Install dependencies ===
  layoutStore.setScaffoldPhase('installing', t('postScaffold.installing').replace('{command}', installCmd))
  layoutStore.addDevServerLog(t('postScaffold.installing').replace('{command}', installCmd), 'info')

  const installSuccess = await runInstall(projectPath, installCmd)

  if (!installSuccess) {
    layoutStore.setScaffoldPhase('error', t('postScaffold.installFailed'))
    return
  }

  // === Phase 2: Start dev server ===
  layoutStore.setScaffoldPhase('starting', t('postScaffold.startingDev').replace('{command}', devCmd))
  layoutStore.addDevServerLog(t('postScaffold.startingDev').replace('{command}', devCmd), 'info')

  try {
    // Preserve fullstack category from the template so dual-port kill and
    // port-authoritative classification kick in (react-express-ts etc.).
    const projectKind: 'frontend' | 'backend' | 'fullstack' =
      template.category === 'backend' ? 'backend'
      : template.category === 'fullstack' ? 'fullstack'
      : 'frontend'
    // Read the frontend port from the same source every start path uses (the
    // .toquemedia-template manifest). Defence-in-depth alongside the Rust
    // probe's `usable_as_frontend` filter — if both fire, we lose neither
    // the explicit port hint nor the content-type signal.
    const frontendPortHint = await resolveFrontendPortHint(projectPath, projectKind)
    await devServerManager.start(projectPath, devCmd, { projectKind, frontendPortHint })
    layoutStore.setScaffoldPhase('ready', t('postScaffold.devRunning'))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    layoutStore.addDevServerLog(
      `Could not start dev server: ${msg}. You can start it manually: ${devCmd}`,
      'error',
    )
    layoutStore.setScaffoldPhase('error', 'Dev server failed to start')
    logger.error('postScaffold', 'Dev server failed:', error)
  }
}

/**
 * Run the install command, streaming output into the dev-server console.
 * Returns true on success. The streaming/timeout/PID-buffering mechanics live
 * in {@link runStreamingInstall}; here we just map the typed result onto the
 * post-scaffold messages. Unlike the preview's `ensureDependenciesInstalled`,
 * this always installs (a fresh scaffold has no node_modules) and uses the
 * caller-chosen command (adapted to the fastest SYSTEM package manager).
 */
async function runInstall(
  projectPath: string,
  installCommand: string,
): Promise<boolean> {
  const layoutStore = useLayoutStore.getState()

  const result = await runStreamingInstall(projectPath, installCommand, {
    onOutput: (text) => layoutStore.addDevServerLog(text, 'info'),
  })

  if (result.ok) {
    layoutStore.addDevServerLog(t('postScaffold.installSuccess'), 'info')
    return true
  }

  if (result.reason === 'timeout') {
    layoutStore.addDevServerLog(
      t('postScaffold.installTimeout').replace('{path}', projectPath).replace('{command}', installCommand),
      'error',
    )
    logger.error('postScaffold', 'Install timed out after 5 minutes')
    return false
  }

  if (result.reason === 'exit') {
    layoutStore.addDevServerLog(
      t('postScaffold.installExitCode').replace('{code}', String(result.exitCode)).replace('{path}', projectPath).replace('{command}', installCommand),
      'error',
    )
    logger.error('postScaffold', `Install failed with exit code ${result.exitCode}`)
    return false
  }

  layoutStore.addDevServerLog(
    t('postScaffold.installError').replace('{message}', result.message).replace('{path}', projectPath).replace('{command}', installCommand),
    'error',
  )
  logger.error('postScaffold', 'Install failed:', result.message)
  return false
}
