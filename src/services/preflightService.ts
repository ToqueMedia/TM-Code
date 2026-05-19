import { invoke } from '@/utils/invokeMetrics'

/**
 * Pre-flight availability check for CMD-mode toolkit dependencies.
 *
 * Runs once per process (or on explicit refresh) and caches the result. The CMD
 * status bar reads this to show a green/amber toolkit indicator so users know
 * which artifact-generation skills will work out of the box vs need installs.
 *
 * Intentionally non-blocking — the checks are best-effort and must never delay
 * CMD mode startup. A failed probe maps to `found: false`, not an exception.
 */

export type PreflightChecks = {
  pandoc: ProbeResult
  venv: ProbeResult
  npx: ProbeResult
  /** Seconds (epoch) when the checks ran. Undefined until first run completes. */
  ranAt?: number
}

export interface ProbeResult {
  found: boolean
  version?: string
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

const EMPTY: PreflightChecks = {
  pandoc: { found: false },
  venv: { found: false },
  npx: { found: false },
}

let cache: PreflightChecks = { ...EMPTY }
let inFlight: Promise<PreflightChecks> | null = null

const listeners = new Set<(state: PreflightChecks) => void>()

async function probe(command: string, versionFlag: string): Promise<ProbeResult> {
  try {
    const out = await invoke<CommandResult>('execute_command', {
      command: `${command} ${versionFlag}`,
    })
    if (!out.success) return { found: false }
    const raw = (out.stdout || out.stderr || '').trim()
    // Extract a version-ish token from the first line (handles "pandoc 3.1.1", "Python 3.12.0", etc.)
    const firstLine = raw.split(/\r?\n/)[0] || ''
    const versionMatch = firstLine.match(/\d+\.\d+(?:\.\d+)?/)
    return { found: true, version: versionMatch?.[0] }
  } catch {
    return { found: false }
  }
}

async function runChecks(): Promise<PreflightChecks> {
  const [pandoc, venv, npx] = await Promise.all([
    probe('pandoc', '--version'),
    // `python3 -m venv --help` prints to stdout on success, exit 0.
    probe('python3 -m venv', '--help'),
    probe('npx', '--version'),
  ])
  const next: PreflightChecks = { pandoc, venv, npx, ranAt: Math.floor(Date.now() / 1000) }
  cache = next
  notify()
  return next
}

function notify(): void {
  for (const fn of listeners) fn(cache)
}

export function getPreflightSnapshot(): PreflightChecks {
  return cache
}

export function subscribeToPreflight(fn: (state: PreflightChecks) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Ensure checks have run at least once. Subsequent calls return the cached
 * result until `refreshPreflight()` is called explicitly.
 */
export async function ensurePreflight(): Promise<PreflightChecks> {
  if (cache.ranAt) return cache
  if (!inFlight) {
    inFlight = runChecks().finally(() => { inFlight = null })
  }
  return inFlight
}

export async function refreshPreflight(): Promise<PreflightChecks> {
  inFlight = runChecks().finally(() => { inFlight = null })
  return inFlight
}

/** Count of tools that came back as found — used for a compact status-bar label. */
export function countAvailable(state: PreflightChecks): { available: number; total: number } {
  const probes: ProbeResult[] = [state.pandoc, state.venv, state.npx]
  return { available: probes.filter(p => p.found).length, total: probes.length }
}
