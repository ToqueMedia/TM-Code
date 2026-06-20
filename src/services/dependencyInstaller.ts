/**
 * Dependency installation — shared by the post-scaffold pipeline and the
 * "install on first preview" flow.
 *
 * `runStreamingInstall` is the low-level engine: it spawns an install command
 * via the Rust `run_streaming_command`, forwards stdout/stderr, and resolves on
 * exit (or kills on timeout). It exists as ONE implementation because the
 * event-buffering race is subtle: `run_streaming_command` can emit
 * `cmd-output`/`cmd-exit` BEFORE its `invoke` promise resolves with the PID, so
 * events are buffered by PID and flushed once the PID is known — a naive
 * listener filtering on a not-yet-known PID drops the first lines and sometimes
 * the exit itself.
 *
 * `ensureDependenciesInstalled` is the high-level guard used by the preview:
 * check for `node_modules`, and only when it's missing detect the project's
 * package manager (by lockfile) and run the install, streaming progress.
 */
import { invoke } from '@/utils/invokeMetrics'
import { listen } from '@tauri-apps/api/event'
import { t } from '../i18n'
import { detectProjectPackageManager, getPMCommands } from './packageManagerDetector'
import { logger } from '../utils/logger'

/** Default ceiling for an install before we give up and kill the process. */
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export type DevLogLevel = 'info' | 'warn' | 'error'

export interface StreamingInstallOptions {
  /** Forward each raw stdout/stderr chunk (progress bars / `\r` included). */
  onOutput?: (text: string) => void
  /** Override the 5-minute default. */
  timeoutMs?: number
}

export type StreamingInstallResult =
  | { ok: true }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'exit'; exitCode: number }
  | { ok: false; reason: 'error'; message: string }

/**
 * Spawn an install command, stream its output, and resolve when it exits.
 * Never rejects — failures come back as a typed result so callers can map them
 * to their own messages.
 */
export async function runStreamingInstall(
  projectPath: string,
  installCommand: string,
  options: StreamingInstallOptions = {},
): Promise<StreamingInstallResult> {
  const { onOutput } = options
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS

  // Register listeners BEFORE spawning so we don't miss early events.
  let targetPid = 0
  let finished = false
  let resolveExit: (code: number) => void
  const exitPromise = new Promise<number>((res) => { resolveExit = res })

  // Buffer events that arrive before we learn the PID (see file header).
  const bufferedOutput: { pid: number; data: string }[] = []
  const bufferedExit: { pid: number; code: number }[] = []

  const unOutput = await listen<{ pid: number; stream: string; data: string }>(
    'cmd-output',
    (event) => {
      if (targetPid === 0) {
        bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
      } else if (event.payload.pid === targetPid) {
        onOutput?.(event.payload.data)
      }
    },
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
    },
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

    // Flush events that arrived before invoke returned.
    for (const ev of bufferedOutput) {
      if (ev.pid === pid) onOutput?.(ev.data)
    }
    for (const ev of bufferedExit) {
      if (ev.pid === pid && !finished) {
        finished = true
        cleanup()
        resolveExit!(ev.code)
      }
    }

    // Race exit against the timeout.
    let timeoutTimer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<number>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    })

    let exitCode: number
    try {
      exitCode = (await Promise.race([exitPromise, timeoutPromise])) as number
      clearTimeout(timeoutTimer!)
    } catch {
      clearTimeout(timeoutTimer!)
      cleanup()
      if (targetPid > 0) {
        try { await invoke('kill_process', { pid: targetPid }) } catch {}
      }
      return { ok: false, reason: 'timeout' }
    }

    if (exitCode !== 0) return { ok: false, reason: 'exit', exitCode }
    return { ok: true }
  } catch (error) {
    cleanup()
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'error', message }
  }
}

export interface EnsureDepsOptions {
  /** Sink for human-readable status + streamed install output. */
  onLog?: (text: string, level: DevLogLevel) => void
  /**
   * Fired once we've decided to install (i.e. `node_modules` is missing), with
   * the resolved install command. Lets the caller flip UI into an "installing"
   * state. NOT called when dependencies are already present.
   */
  onInstallStart?: (installCommand: string) => void
  /** Override the install timeout. */
  timeoutMs?: number
}

export type EnsureDepsResult =
  /** `node_modules` already present — nothing was run. */
  | { status: 'present' }
  /** Was missing; installed successfully. */
  | { status: 'installed' }
  /** No `package.json` — nothing to install (caller proceeds at its own risk). */
  | { status: 'skipped' }
  /** Install ran but failed; `message` is already logged via `onLog`. */
  | { status: 'failed'; message: string }

/**
 * Ensure a project's dependencies are installed before something needs them
 * (e.g. starting the dev server for the preview). Fast no-op when
 * `node_modules` exists; otherwise installs with the project's package manager
 * and streams progress through `onLog`.
 */
export async function ensureDependenciesInstalled(
  projectPath: string,
  options: EnsureDepsOptions = {},
): Promise<EnsureDepsResult> {
  const { onLog } = options
  const sep = projectPath.includes('\\') ? '\\' : '/'

  // Already installed — fast path.
  let present = false
  try {
    present = await invoke<boolean>('path_exists', { path: `${projectPath}${sep}node_modules` })
  } catch { /* treat as missing — install is idempotent */ }
  if (present) return { status: 'present' }

  // No package.json → nothing we can install. Defensive: the dev-command
  // detection already fails in that case, so callers rarely reach here.
  let hasPkg = false
  try {
    hasPkg = await invoke<boolean>('path_exists', { path: `${projectPath}${sep}package.json` })
  } catch { /* ignore */ }
  if (!hasPkg) return { status: 'skipped' }

  const pm = await detectProjectPackageManager(projectPath)
  const installCommand = getPMCommands(pm).install

  options.onInstallStart?.(installCommand)
  onLog?.(t('postScaffold.installing').replace('{command}', installCommand), 'info')

  const result = await runStreamingInstall(projectPath, installCommand, {
    onOutput: (text) => onLog?.(text, 'info'),
    timeoutMs: options.timeoutMs,
  })

  if (result.ok) {
    onLog?.(t('postScaffold.installSuccess'), 'info')
    return { status: 'installed' }
  }

  let message: string
  if (result.reason === 'timeout') {
    message = t('postScaffold.installTimeout')
      .replace('{path}', projectPath)
      .replace('{command}', installCommand)
    logger.error('deps', 'Install timed out')
  } else if (result.reason === 'exit') {
    message = t('postScaffold.installExitCode')
      .replace('{code}', String(result.exitCode))
      .replace('{path}', projectPath)
      .replace('{command}', installCommand)
    logger.error('deps', `Install failed with exit code ${result.exitCode}`)
  } else {
    message = t('postScaffold.installError')
      .replace('{message}', result.message)
      .replace('{path}', projectPath)
      .replace('{command}', installCommand)
    logger.error('deps', 'Install failed:', result.message)
  }
  onLog?.(message, 'error')
  return { status: 'failed', message }
}
