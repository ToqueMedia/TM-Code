import { invoke } from '@tauri-apps/api/core'
import { Requirement } from './templateService'

export interface CheckResult {
  requirement: Requirement
  found: boolean
  version: string | null
  meetsMinimum: boolean
  error: string | null
}

export interface EnvironmentCheckResult {
  allPassed: boolean
  results: CheckResult[]
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

const cache = new Map<string, {
  result: EnvironmentCheckResult
  timestamp: number
}>()

async function checkSingle(req: Requirement): Promise<CheckResult> {
  try {
    // Use home directory as cwd to avoid corepack interference.
    // When cwd contains a package.json with "packageManager", corepack blocks
    // other package managers (e.g. pnpm returns exit 1 in a yarn project).
    const homeDir = await invoke<string>('get_home_directory').catch(() => null)
    const output = await invoke<CommandResult>('execute_command', {
      command: `${req.command} ${req.versionFlag}`,
      cwd: homeDir,
    })

    if (!output.success) {
      return {
        requirement: req,
        found: false,
        version: null,
        meetsMinimum: false,
        error: `Command failed: ${req.command}`,
      }
    }

    const rawOutput = (output.stdout || output.stderr || '').trim()
    const version = extractVersion(rawOutput)

    if (!version) {
      return {
        requirement: req,
        found: true,
        version: null,
        meetsMinimum: false,
        error: `Could not parse version from: ${rawOutput}`,
      }
    }

    const meetsMinimum = compareVersions(version, req.minVersion) >= 0

    return {
      requirement: req,
      found: true,
      version,
      meetsMinimum,
      error: meetsMinimum ? null : `Version ${version} is below minimum ${req.minVersion}`,
    }
  } catch {
    return {
      requirement: req,
      found: false,
      version: null,
      meetsMinimum: false,
      error: `${req.name} not found. Is it installed and in your PATH?`,
    }
  }
}

/**
 * Extract a semantic version from arbitrary command output.
 * Handles: v22.1.0, 10.8.0, go1.22.3, Python 3.12.0, pip 24.0
 */
function extractVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+(?:\.\d+)?)/)
  return match ? match[1] : null
}

/**
 * Compare two semver-like version strings.
 * Returns: >0 if a > b, 0 if equal, <0 if a < b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  const len = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) return numA - numB
  }
  return 0
}

/**
 * Verify that all requirements are met.
 * Runs checks in parallel. Results are cached for 5 minutes.
 * On unexpected errors, returns allPassed: true to avoid blocking the user.
 */
export async function verifyRequirements(
  requirements: Requirement[],
): Promise<EnvironmentCheckResult> {
  try {
    // Cache key includes minVersion to avoid false positives across templates
    const cacheKey = requirements
      .map(r => `${r.command}@${r.minVersion}`)
      .sort()
      .join(',')

    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.result
    }

    const results = await Promise.all(requirements.map(checkSingle))

    const result: EnvironmentCheckResult = {
      allPassed: results.every(r => r.found && r.meetsMinimum),
      results,
    }

    cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  } catch {
    // Graceful degradation: don't block scaffold on IPC/unexpected errors
    return { allPassed: true, results: [] }
  }
}

/** Clear the cache (e.g. after user says they installed a tool). */
export function clearRequirementsCache(): void {
  cache.clear()
}
