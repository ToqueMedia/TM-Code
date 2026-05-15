import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useProjectStore } from '../stores/projectStore'
import { useLayoutStore } from '../stores/layoutStore'
import { devServerManager } from './devServerManager'
import { templateService, Template, resolveFrontendPortHint } from './templateService'
import { detectSystemPackageManager, adaptCommand } from './packageManagerDetector'
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
  layoutStore.setScaffoldPhase('installing', `Installing dependencies (${installCmd})...`)
  layoutStore.addDevServerLog(`Installing dependencies (${installCmd})...`, 'info')

  const installSuccess = await runInstall(projectPath, installCmd)

  if (!installSuccess) {
    layoutStore.setScaffoldPhase('error', 'Failed to install dependencies')
    return
  }

  // === Phase 2: Start dev server ===
  layoutStore.setScaffoldPhase('starting', `Starting dev server (${devCmd})...`)
  layoutStore.addDevServerLog(`Starting dev server (${devCmd})...`, 'info')

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
    layoutStore.setScaffoldPhase('ready', 'Dev server is running')
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
 * Run the install command. Returns true on success.
 * Uses a simple PID-tracking approach — events are buffered if they arrive
 * before invoke returns, avoiding the async pidReady pattern that can lose events.
 */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

async function runInstall(
  projectPath: string,
  installCommand: string,
): Promise<boolean> {
  const layoutStore = useLayoutStore.getState()

  // Register listeners BEFORE spawning
  let targetPid = 0
  let finished = false
  let resolveExit: (code: number) => void
  const exitPromise = new Promise<number>((res) => {
    resolveExit = res
  })

  // Buffer events that arrive before we know the PID
  const bufferedOutput: { pid: number; data: string }[] = []
  const bufferedExit: { pid: number; code: number }[] = []

  const unOutput = await listen<{ pid: number; stream: string; data: string }>(
    'cmd-output',
    (event) => {
      if (targetPid === 0) {
        bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
      } else if (event.payload.pid === targetPid) {
        layoutStore.addDevServerLog(event.payload.data, 'info')
      }
    }
  )

  const unExit = await listen<{ pid: number; code: number }>(
    'cmd-exit',
    (event) => {
      if (targetPid === 0) {
        bufferedExit.push({ pid: event.payload.pid, code: event.payload.code })
      } else if (event.payload.pid === targetPid && !finished) {
        finished = true
        cleanup()
        resolveExit(event.payload.code)
      }
    }
  )

  const cleanup = () => {
    unOutput()
    unExit()
  }

  try {
    const pid = await invoke<number>('run_streaming_command', {
      command: installCommand,
      cwd: projectPath,
    })
    targetPid = pid

    // Flush buffered events that arrived before invoke returned
    for (const ev of bufferedOutput) {
      if (ev.pid === pid) {
        layoutStore.addDevServerLog(ev.data, 'info')
      }
    }
    for (const ev of bufferedExit) {
      if (ev.pid === pid && !finished) {
        finished = true
        cleanup()
        resolveExit!(ev.code)
      }
    }

    // Race between exit and timeout
    let timeoutTimer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<number>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('timeout')), INSTALL_TIMEOUT_MS)
    })

    let exitCode: number
    try {
      exitCode = await Promise.race([exitPromise, timeoutPromise]) as number
      clearTimeout(timeoutTimer!)
    } catch (err) {
      clearTimeout(timeoutTimer!)
      // Timeout — kill the process and suggest manual install
      cleanup()
      if (targetPid > 0) {
        try { await invoke('kill_process', { pid: targetPid }) } catch {}
      }
      layoutStore.addDevServerLog(
        `Install timed out after 5 minutes and was cancelled.\n` +
        `Run manually in the terminal:\n  cd ${projectPath}\n  ${installCommand}`,
        'error',
      )
      logger.error('postScaffold', 'Install timed out after 5 minutes')
      return false
    }

    if (exitCode !== 0) {
      layoutStore.addDevServerLog(
        `Failed to install dependencies (exit code ${exitCode}).\n` +
        `Run manually in the terminal:\n  cd ${projectPath}\n  ${installCommand}`,
        'error',
      )
      logger.error('postScaffold', `Install failed with exit code ${exitCode}`)
      return false
    }

    layoutStore.addDevServerLog('Dependencies installed successfully', 'info')
    return true
  } catch (error) {
    cleanup()
    const msg = error instanceof Error ? error.message : String(error)
    layoutStore.addDevServerLog(
      `Failed to install dependencies: ${msg}\n` +
      `Run manually in the terminal:\n  cd ${projectPath}\n  ${installCommand}`,
      'error',
    )
    logger.error('postScaffold', 'Install failed:', error)
    return false
  }
}
