import { invoke } from '@/utils/invokeMetrics'
import { logger } from '../utils/logger'

export type PackageManager = 'bun' | 'yarn' | 'pnpm' | 'npm'

interface PMCommands {
  install: string
  run: string
  add: string
}

const PM_COMMANDS: Record<PackageManager, PMCommands> = {
  bun:  { install: 'bun install',  run: 'bun run',  add: 'bun add' },
  yarn: { install: 'yarn install', run: 'yarn',     add: 'yarn add' },
  pnpm: { install: 'pnpm install', run: 'pnpm run', add: 'pnpm add' },
  npm:  { install: 'npm install',  run: 'npm run',  add: 'npm add' },
}

// Detection order: npm first (universally available with Node.js)
const PM_PRIORITY: PackageManager[] = ['npm', 'pnpm']

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
          cwd: navigator.platform?.startsWith('Win') ? 'C:\\' : '/tmp',
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
 * Replaces npm/pnpm/bun/yarn commands with the target package manager equivalent.
 * e.g., adaptCommand("npm install", "pnpm") → "pnpm install"
 */
export function adaptCommand(command: string, targetPM: PackageManager): string {
  if (!command) return command
  return command
    .replace(/^(npm|pnpm|bun|yarn)\s+install\b/, `${targetPM} install`)
    .replace(/^(npm|pnpm|bun|yarn)\s+run\b/, `${targetPM} run`)
    .replace(/^(npm|pnpm|bun|yarn)\s+start\b/, `${targetPM} start`)
    .replace(/^(npm|pnpm|bun|yarn)\s+add\b/, `${targetPM} add`)
    .replace(/^(npm|pnpm|bun|yarn)\s+ci\b/, `${targetPM} ci`)
}

/**
 * Detect the package manager a PROJECT uses, from its committed lockfile.
 *
 * Distinct from {@link detectSystemPackageManager}, which probes what's
 * installed to pick the fastest. This respects the project's own lockfile so a
 * preview/run path never fires `npm install` inside a yarn/pnpm project (which
 * would create a competing lockfile and a second, divergent node_modules).
 * Precedence matches the Live Preview and `/start-server` paths so every
 * install/run surface agrees on the PM for a given project. Falls back to
 * `npm` when no lockfile is present.
 */
export async function detectProjectPackageManager(projectPath: string): Promise<PackageManager> {
  const sep = projectPath.includes('\\') ? '\\' : '/'
  const checks: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ]
  for (const [file, pm] of checks) {
    try {
      if (await invoke<boolean>('path_exists', { path: `${projectPath}${sep}${file}` })) return pm
    } catch {
      // path_exists rejected (unlikely) — fall through to the next candidate.
    }
  }
  return 'npm'
}
