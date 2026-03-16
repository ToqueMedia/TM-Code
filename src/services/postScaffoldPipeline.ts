import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { devServerManager } from './devServerManager'
import { templateService, Template } from './templateService'
import { logger } from '../utils/logger'

interface CommandResult {
  stdout: string
  stderr: string
  exit_code: number
  success: boolean
}

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
  await useChatStore.getState().createNewSession(projectPath)

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
  const chatStore = useChatStore.getState()

  // === Phase 1: Install dependencies ===
  chatStore.addSystemMessage(
    `Installing dependencies (${template.installCommand})... This may take a minute.`,
  )

  const installSuccess = await runInstall(projectPath, template)

  if (!installSuccess) {
    // Install failed — don't attempt to start the dev server
    return
  }

  // === Phase 2: Start dev server ===
  chatStore.addSystemMessage(`Starting dev server (${template.devCommand})...`)

  try {
    await devServerManager.start(projectPath, template.devCommand)
    // URL detection + preview transition happens inside devServerManager
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    chatStore.addSystemMessage(
      `Could not start dev server: ${msg}\nYou can start it manually: ${template.devCommand}`,
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
  const chatStore = useChatStore.getState()

  try {
    const result = await invoke<CommandResult>('execute_command', {
      command: template.installCommand,
      cwd: projectPath,
    })

    if (!result.success) {
      chatStore.addSystemMessage(
        `Failed to install dependencies (exit code ${result.exit_code}).\n${result.stderr?.slice(0, 500) || ''}\nYou can try running "${template.installCommand}" manually.`,
      )
      logger.error('postScaffold', 'Install failed:', result.stderr)
      return false
    }

    chatStore.addSystemMessage('Dependencies installed successfully')
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    chatStore.addSystemMessage(
      `Failed to install dependencies: ${msg}\nYou can try running "${template.installCommand}" manually.`,
    )
    logger.error('postScaffold', 'Install failed:', error)
    return false
  }
}
