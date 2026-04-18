import { verifyRequirements, clearRequirementsCache, type EnvironmentCheckResult } from './environmentCheck'
import type { Requirement } from './templateService'
import { IS_WINDOWS } from '@/utils/platform'

/**
 * Global tool prerequisites for the IDE. Checked once on startup and cached
 * for 24h — independent of the per-template requirement list in templateService.
 *
 * These are the universal minimums: most scaffolds won't boot without them, and
 * the agent expects them to be present when running shell commands. A missing
 * tool doesn't block launch — we just surface a banner so the user can install.
 */
export const GLOBAL_REQUIREMENTS: Requirement[] = [
  {
    name: 'Node.js',
    command: 'node',
    versionFlag: '--version',
    minVersion: '20.0.0',
    installUrl: 'https://nodejs.org',
    installHint: 'Download from nodejs.org or install via nvm/fnm',
  },
  {
    name: 'Git',
    command: 'git',
    versionFlag: '--version',
    minVersion: '2.0.0',
    installUrl: IS_WINDOWS ? 'https://git-scm.com/download/win' : 'https://git-scm.com/downloads',
    installHint: IS_WINDOWS ? 'Download from git-scm.com' : 'Install via your package manager (brew, apt, etc.)',
  },
  {
    name: 'Python 3',
    // Windows Python installer registers both `python` and `python3` from 3.11+.
    // For older Windows installs we'd need a fallback, but that's uncommon enough
    // to let the banner surface the install hint rather than silently pass.
    command: 'python3',
    versionFlag: '--version',
    minVersion: '3.8.0',
    installUrl: 'https://www.python.org/downloads/',
    installHint: IS_WINDOWS
      ? 'Download from python.org (check "Add to PATH" during install)'
      : 'Install via your package manager (brew install python3, apt install python3)',
  },
]

const STORAGE_KEY = 'tm-startup-requirements-v1'
const TTL_MS = 24 * 60 * 60 * 1000 // 24h

interface PersistedCheck {
  timestamp: number
  result: EnvironmentCheckResult
}

/** Read the persisted check if still fresh (within 24h). */
function readCache(): EnvironmentCheckResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedCheck
    if (Date.now() - parsed.timestamp > TTL_MS) return null
    return parsed.result
  } catch {
    return null
  }
}

function writeCache(result: EnvironmentCheckResult): void {
  try {
    const payload: PersistedCheck = { timestamp: Date.now(), result }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Quota or privacy mode — non-fatal
  }
}

/**
 * Check global prerequisites (Node, Git, Python 3).
 * Uses a 24h localStorage cache so the dev tooling check doesn't run on every app launch.
 * The underlying environmentCheck also has an in-memory 5min cache for same-session reruns.
 */
export async function checkStartupRequirements(forceRefresh = false): Promise<EnvironmentCheckResult> {
  if (!forceRefresh) {
    const cached = readCache()
    if (cached) return cached
  }

  const result = await verifyRequirements(GLOBAL_REQUIREMENTS)
  writeCache(result)
  return result
}

/** Forget the persisted check — next call will re-run tools. */
export function clearStartupRequirementsCache(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  clearRequirementsCache()
}
