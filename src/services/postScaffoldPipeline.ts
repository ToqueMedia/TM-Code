import { invoke } from '@tauri-apps/api/core'
import { useProjectStore } from '../stores/projectStore'
import { useLayoutStore } from '../stores/layoutStore'
import { devServerManager } from './devServerManager'
import { templateService, Template } from './templateService'
import { logger } from '../utils/logger'

/**
 * Full scaffold flow: copy template → open project → create session → run pipeline.
 * Shared by WelcomeScreen and MainLayout to avoid duplication.
 * Returns the project path on success, null if the user cancelled.
 */
export async function setupScaffoldedProject(
  template: Template,
  projectPath: string,
): Promise<void> {
  await templateService.scaffold(template.id, projectPath)
  await useProjectStore.getState().openProject(projectPath)
  // Session creation is handled by App.tsx's useEffect on currentProject change

  // Post-scaffold pipeline runs in background (install + dev server)
  postScaffoldPipeline(projectPath, template)
    .catch(err => logger.error('scaffold', 'Post-scaffold pipeline failed:', err))
}

/**
 * Orchestrates the post-scaffold flow:
 * 1. Install dependencies (npm install / pip install / go mod tidy)
 * 2. Start dev server (npm run dev / uvicorn / go run)
 * 3. Auto-transition to preview when URL is detected
 */
async function postScaffoldPipeline(
  projectPath: string,
  template: Template,
): Promise<void> {
  const layoutStore = useLayoutStore.getState()

  // === Phase 1: Install dependencies ===
  layoutStore.addDevServerLog(
    `Installing dependencies (${template.installCommand})...`,
    'info',
  )

  const installSuccess = await runInstall(projectPath, template)

  if (!installSuccess) {
    // Install failed — don't attempt to start the dev server
    return
  }

  // === Phase 2: Start dev server ===
  layoutStore.addDevServerLog(`Starting dev server (${template.devCommand})...`, 'info')

  try {
    await devServerManager.start(projectPath, template.devCommand)
    // URL detection + preview transition happens inside devServerManager
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    layoutStore.addDevServerLog(
      `Could not start dev server: ${msg}. You can start it manually: ${template.devCommand}`,
      'error',
    )
    logger.error('postScaffold', 'Dev server failed:', error)
  }
}

/**
 * Run the template's install command. Returns true on success.
 *
 * For monorepo templates that use npm workspaces (like react-express-ts),
 * the root `npm install` already handles all workspaces — no special logic
 * is needed. Templates that need custom install behaviour should encode it
 * in their installCommand (e.g. a script that installs sub-projects).
 */
async function runInstall(
  projectPath: string,
  template: Template,
): Promise<boolean> {
  const layoutStore = useLayoutStore.getState()

  try {
    // Use streaming command to show npm install progress in real-time
    const pid = await invoke<number>('run_streaming_command', {
      command: template.installCommand,
      cwd: projectPath,
    })

    // Stream output to the dev server log panel
    const { listen } = await import('@tauri-apps/api/event')

    const exitCode = await new Promise<number>(async (resolve) => {
      const unOutput = await listen<{ pid: number; stream: string; data: string }>(
        'cmd-output',
        (event) => {
          if (event.payload.pid !== pid) return
          layoutStore.addDevServerLog(event.payload.data, 'info')
        }
      )

      const unExit = await listen<{ pid: number; code: number }>(
        'cmd-exit',
        (event) => {
          if (event.payload.pid !== pid) return
          unOutput()
          unExit()
          resolve(event.payload.code)
        }
      )
    })

    if (exitCode !== 0) {
      layoutStore.addDevServerLog(
        `Failed to install dependencies (exit code ${exitCode})`,
        'error',
      )
      logger.error('postScaffold', `Install failed with exit code ${exitCode}`)
      return false
    }

    layoutStore.addDevServerLog('Dependencies installed successfully', 'info')
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    layoutStore.addDevServerLog(
      `Failed to install dependencies: ${msg}`,
      'error',
    )
    logger.error('postScaffold', 'Install failed:', error)
    return false
  }
}
