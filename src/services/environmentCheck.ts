import { invoke } from '@/utils/invokeMetrics'
import { Requirement } from './templateService'
import { IS_WINDOWS } from '@/utils/platform'
import { t } from '@/i18n'

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
  /** Map of requirement name to its check result for O(1) lookup in UI */
  requirements: Record<string, CheckResult>
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

interface CommandCandidate {
  label: string
  command: string
}

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

const cache = new Map<string, {
  result: EnvironmentCheckResult
  timestamp: number
}>()

async function checkSingle(req: Requirement): Promise<CheckResult> {
  const homeDir = await invoke<string>('get_home_directory').catch(() => null)
  
  // Support multiple commands for the same requirement (e.g. python3 OR python)
  const commandsToTry = getCommandCandidates(req, homeDir)

  let lastError = ''
  let bestOutdated: CheckResult | null = null

  for (const candidate of commandsToTry) {
    try {
      console.log(`[envCheck] Checking ${req.name} via "${candidate.label}"`)
      
      const output = await invoke<CommandResult>('execute_command', {
        command: candidate.command,
        cwd: homeDir,
      })

      console.log(`[envCheck] Result for ${req.name} (${candidate.label}):`, output)

      if (output.success) {
        const rawOutput = (output.stdout || output.stderr || '').trim()
        const version = extractVersion(rawOutput)

        if (version) {
          const meetsMinimum = compareVersions(version, req.minVersion) >= 0
          const result = {
            requirement: req,
            found: true,
            version,
            meetsMinimum,
            error: meetsMinimum ? null : t('env.versionBelowMin').replace('{version}', version).replace('{min}', req.minVersion),
          }
          if (meetsMinimum) return result
          if (!bestOutdated || compareVersions(version, bestOutdated.version || '0.0.0') > 0) {
            bestOutdated = result
          }
          lastError = result.error || ''
          continue
        }
        lastError = t('env.parseFailed').replace('{output}', rawOutput)
      } else {
        lastError = t('env.commandFailed').replace('{command}', candidate.label)
      }
    } catch (e) {
      lastError = String(e)
    }
  }

  if (bestOutdated) return bestOutdated

  return {
    requirement: req,
    found: false,
    version: null,
    meetsMinimum: false,
    error: `${req.name} not found. ${lastError}`,
  }
}

function quoteCommandPath(path: string): string {
  return /[\s()]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path
}

function commandCandidate(command: string, versionFlag: string, label = command): CommandCandidate {
  return { label, command: `${command} ${versionFlag}` }
}

function literalShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function latestExecutableVersionCommand(globPattern: string): string {
  return `bash -lc ${literalShellSingleQuoted(`for bin in ${globPattern}; do [ -x "$bin" ] || continue; "$bin" --version; done | awk '{ raw=$0; v=$0; sub(/^v/, "", v); split(v, a, "."); score=(a[1]+0)*1000000000+(a[2]+0)*1000000+(a[3]+0); if (score > bestScore) { bestScore=score; best=raw } } END { if (best != "") print best }'`)}`
}

function getCommandCandidates(req: Requirement, homeDir: string | null): CommandCandidate[] {
  const candidates: CommandCandidate[] = [commandCandidate(req.command, req.versionFlag)]

  if (req.name === 'Python 3') {
    if (IS_WINDOWS) {
      candidates.push(
        commandCandidate('python3', req.versionFlag),
        commandCandidate('py -3', req.versionFlag),
      )
    } else {
      candidates.push(commandCandidate('python', req.versionFlag))
      if (homeDir) {
        candidates.push(
          commandCandidate(`${homeDir}/.pyenv/shims/python3`, req.versionFlag),
          commandCandidate(`${homeDir}/.asdf/shims/python3`, req.versionFlag),
        )
      }
      candidates.push(
        commandCandidate('/opt/homebrew/bin/python3', req.versionFlag),
        commandCandidate('/usr/local/bin/python3', req.versionFlag),
      )
    }
  }

  if (req.name === 'Node.js') {
    if (homeDir) {
      candidates.push(
        commandCandidate(`${homeDir}/.volta/bin/node`, req.versionFlag),
        commandCandidate(`${homeDir}/.asdf/shims/node`, req.versionFlag),
        commandCandidate(`${homeDir}/.nodenv/shims/node`, req.versionFlag),
        commandCandidate(`${homeDir}/.local/share/fnm/node-versions/current/installation/bin/node`, req.versionFlag),
      )
    }
    if (!IS_WINDOWS) {
      // `nvm use 20` only changes the PATH of the terminal where it ran; a
      // running Tauri app will not inherit it. Probe installed nvm versions
      // directly and return the highest node binary found.
      candidates.push({
        label: 'nvm installed node versions',
        command: latestExecutableVersionCommand('"$HOME"/.nvm/versions/node/v*/bin/node'),
      })
      candidates.push({
        label: 'fnm installed node versions',
        command: latestExecutableVersionCommand('"$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node "$HOME"/Library/Application\\ Support/fnm/node-versions/v*/installation/bin/node'),
      })
      candidates.push({
        label: 'asdf installed node versions',
        command: latestExecutableVersionCommand('"$HOME"/.asdf/installs/nodejs/*/bin/node'),
      })
      candidates.push({
        label: 'nodenv installed node versions',
        command: latestExecutableVersionCommand('"$HOME"/.nodenv/versions/*/bin/node'),
      })
      candidates.push(
        commandCandidate('/opt/homebrew/bin/node', req.versionFlag),
        commandCandidate('/usr/local/bin/node', req.versionFlag),
      )
    }
  }

  if (req.name === 'Git') {
    if (IS_WINDOWS) {
      candidates.push(
        commandCandidate(quoteCommandPath('C:\\Program Files\\Git\\cmd\\git.exe'), req.versionFlag),
        commandCandidate(quoteCommandPath('C:\\Program Files (x86)\\Git\\cmd\\git.exe'), req.versionFlag),
      )
    } else {
      candidates.push(
        commandCandidate('/opt/homebrew/bin/git', req.versionFlag),
        commandCandidate('/usr/local/bin/git', req.versionFlag),
      )
    }
  }

  const seen = new Set<string>()
  return candidates.filter(candidate => {
    if (!candidate.command || seen.has(candidate.command)) return false
    seen.add(candidate.command)
    return true
  })
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
      requirements: Object.fromEntries(results.map(r => [r.requirement.name, r])),
    }

    cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  } catch {
    // Graceful degradation: don't block scaffold on IPC/unexpected errors
    return { allPassed: true, results: [], requirements: {} }
  }
}

/** Clear the cache (e.g. after user says they installed a tool). */
export function clearRequirementsCache(): void {
  cache.clear()
}
