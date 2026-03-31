import { invoke } from '@tauri-apps/api/core'
import { logger } from '../utils/logger'

export type PackageManager = 'bun' | 'pnpm' | 'npm'

interface PMCommands {
  install: string
  run: string
  add: string
}

const PM_COMMANDS: Record<PackageManager, PMCommands> = {
  bun:  { install: 'bun install',  run: 'bun run',  add: 'bun add' },
  pnpm: { install: 'pnpm install', run: 'pnpm run', add: 'pnpm add' },
  npm:  { install: 'npm install',  run: 'npm run',  add: 'npm add' },
}

// Detection order: fastest first
const PM_PRIORITY: PackageManager[] = ['pnpm', 'npm']

let cachedPM: PackageManager | null = null
let detecting: Promise<PackageManager> | null = null

/**
 * Detects the fastest package manager available on the system.
 * Checks pnpm → npm (bun excluded for now — less mature ecosystem).
 * Result is cached for the entire app session.
 */
export async function detectSystemPackageManager(): Promise<PackageManager> {
  if (cachedPM) return cachedPM
  // Deduplicate concurrent calls
  if (detecting) return detecting

  detecting = (async () => {
    for (const pm of PM_PRIORITY) {
      try {
        const result = await invoke<{
          stdout: string
          stderr: string
          exitCode: number
          success: boolean
          timedOut: boolean
        }>('execute_command', {
          command: `${pm} --version`,
          cwd: '/tmp',
          timeoutSecs: 5,
        })

        if (result.success && result.exitCode === 0) {
          const version = result.stdout.trim().split('\n')[0]
          logger.info('pm-detect', `Detected ${pm} ${version}`)
          cachedPM = pm
          return pm
        }
      } catch {
        // PM not available, try next
      }
    }

    // npm is always available with Node.js
    cachedPM = 'npm'
    return 'npm' as PackageManager
  })()

  try {
    const result = await detecting
    return result
  } finally {
    detecting = null
  }
}

/** Returns the cached PM without async detection (returns null if not yet detected). */
export function getCachedPackageManager(): PackageManager | null {
  return cachedPM
}

/** Returns install/run/add commands for the given PM. */
export function getPMCommands(pm: PackageManager): PMCommands {
  return PM_COMMANDS[pm]
}

/**
 * Replaces npm/pnpm/bun commands with the target package manager equivalent.
 * e.g., adaptCommand("npm install", "pnpm") → "pnpm install"
 */
export function adaptCommand(command: string, targetPM: PackageManager): string {
  if (!command) return command
  return command
    .replace(/^(npm|pnpm|bun)\s+install\b/, `${targetPM} install`)
    .replace(/^(npm|pnpm|bun)\s+run\b/, `${targetPM} run`)
    .replace(/^(npm|pnpm|bun)\s+start\b/, `${targetPM} start`)
    .replace(/^(npm|pnpm|bun)\s+add\b/, `${targetPM} add`)
    .replace(/^(npm|pnpm|bun)\s+ci\b/, `${targetPM} ci`)
}
