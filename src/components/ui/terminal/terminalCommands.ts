/**
 * Built-in terminal command handlers (cd, pwd, clear, etc.)
 * and the main command execution dispatcher.
 *
 * Container Code isolation:
 *   - Docker mode  → commands run inside container, paths virtual
 *   - App-level    → commands run on host with cwd clamped, paths virtual
 *   - No isolation → original behaviour
 */

import { Terminal as XTerm } from '@xterm/xterm';
import TerminalService from '@/services/terminalService';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  isProjectIsolated,
  isContainerActive,
  getContainerProjectPath,
} from '@/stores/containerStore';

export interface TerminalSessionInfo {
  id: string;
  name: string;
  cwd: string;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Convert a host path to a virtual display path for the terminal prompt.
 *
 * Isolated mode: `/Users/me/project/src` → `/src`
 * Normal mode:   `~/...` truncation
 */
export async function getDisplayPath(fullPath: string): Promise<string> {
  const projectPath = getContainerProjectPath();

  if (isProjectIsolated() && projectPath) {
    if (fullPath === projectPath || fullPath === projectPath + '/') {
      return '/';
    }
    const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    if (fullPath.startsWith(prefix)) {
      const virtualPath = fullPath.slice(projectPath.length);
      return virtualPath.length > 25 ? '...' + virtualPath.slice(-22) : virtualPath;
    }
  }

  // Normal mode: show relative to home
  try {
    const homeDir = (await invoke('get_home_directory')) as string;
    if (fullPath.startsWith(homeDir)) {
      const relativePath = fullPath.replace(homeDir, '~');
      return relativePath.length > 25 ? '...' + relativePath.slice(-22) : relativePath;
    }
    return fullPath.length > 25 ? '...' + fullPath.slice(-22) : fullPath;
  } catch {
    return fullPath.length > 25 ? '...' + fullPath.slice(-22) : fullPath;
  }
}

/**
 * Clamp a resolved path so it cannot escape the project root.
 */
function clampToProject(resolvedPath: string, projectPath: string): string {
  if (resolvedPath === projectPath) return resolvedPath;
  const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/';
  return resolvedPath.startsWith(prefix) ? resolvedPath : projectPath;
}

/** Safe terminal write — silently ignores disposed terminals. */
function safeTermWrite(terminal: XTerm, data: string) {
  try { terminal.write(data) } catch { /* terminal disposed */ }
}

/**
 * Write the shell prompt to the terminal.
 */
export async function displayPrompt(
  terminal: XTerm,
  session: TerminalSessionInfo | undefined
): Promise<void> {
  const cwd = session?.cwd || '~';
  const displayPath = await getDisplayPath(cwd);
  const name = session?.name || 'terminal';

  if (isContainerActive()) {
    safeTermWrite(terminal,
      `\x1b[35m\x1b[1m[container]\x1b[0m \x1b[32m\x1b[1m${name}\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `
    );
  } else {
    safeTermWrite(terminal,
      `\x1b[32m\x1b[1m${name}\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `
    );
  }
}

/**
 * Handle the `cd` command.
 */
export async function handleChangeDirectory(
  targetPath: string,
  terminal: XTerm,
  session: TerminalSessionInfo,
  updateSessionCwd: (id: string, cwd: string) => void
): Promise<void> {
  const isolated = isProjectIsolated();
  const projectPath = getContainerProjectPath();

  try {
    let resolvedPath = targetPath;

    if (isolated && projectPath) {
      if (targetPath === '~' || targetPath === '' || targetPath === '/') {
        resolvedPath = projectPath;
      } else if (targetPath === '..') {
        const pathParts = session.cwd.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
          pathParts.pop();
          resolvedPath = '/' + pathParts.join('/') || '/';
        } else {
          resolvedPath = '/';
        }
        resolvedPath = clampToProject(resolvedPath, projectPath);
      } else if (targetPath === '.') {
        resolvedPath = session.cwd;
      } else if (targetPath.startsWith('/')) {
        resolvedPath = projectPath + targetPath;
      } else {
        resolvedPath = session.cwd + '/' + targetPath;
      }
    } else {
      if (targetPath === '~' || targetPath === '') {
        resolvedPath = (await invoke('get_home_directory')) as string;
      } else if (targetPath === '..') {
        const pathParts = session.cwd.split('/').filter(p => p.length > 0);
        if (pathParts.length > 0) {
          pathParts.pop();
          resolvedPath = '/' + pathParts.join('/') || '/';
        } else {
          resolvedPath = '/';
        }
      } else if (targetPath === '.') {
        resolvedPath = session.cwd;
      } else if (!targetPath.startsWith('/')) {
        resolvedPath = session.cwd + '/' + targetPath;
      }
    }

    resolvedPath = resolvedPath.replace(/\/+/g, '/');
    if (resolvedPath.length > 1 && resolvedPath.endsWith('/')) {
      resolvedPath = resolvedPath.slice(0, -1);
    }

    const result = await TerminalService.shared.executeCommand('ls', resolvedPath);

    if (result.success) {
      updateSessionCwd(session.id, resolvedPath);
      await displayPrompt(terminal, { ...session, cwd: resolvedPath });
    } else {
      safeTermWrite(terminal, `\x1b[31mcd: no such file or directory: ${targetPath}\x1b[0m\r\n`);
      await displayPrompt(terminal, session);
    }
  } catch (error) {
    safeTermWrite(terminal, `\x1b[31mcd: ${error}\x1b[0m\r\n`);
    await displayPrompt(terminal, session);
  }
}

/**
 * Execute a command with real-time streaming output.
 * Uses `run_streaming_command` which spawns the process and streams
 * stdout/stderr via Tauri events, giving immediate feedback.
 */
export async function executeCommand(
  command: string,
  terminal: XTerm,
  session: TerminalSessionInfo,
  updateSessionCwd: (id: string, cwd: string) => void,
  commandLockRef: React.MutableRefObject<boolean>,
  _xtermRef: React.MutableRefObject<XTerm | null>
): Promise<void> {
  if (commandLockRef.current || !session) return;

  commandLockRef.current = true;

  try {
    safeTermWrite(terminal, '\r\n');

    // Built-in: clear
    if (command === 'clear') {
      terminal.clear();
      await displayPrompt(terminal, session);
      return;
    }

    // Built-in: cd
    if (command.startsWith('cd ')) {
      const newPath = command.substring(3).trim();
      await handleChangeDirectory(newPath, terminal, session, updateSessionCwd);
      return;
    } else if (command === 'cd') {
      const projectPath = getContainerProjectPath();
      if (isProjectIsolated() && projectPath) {
        await handleChangeDirectory(projectPath, terminal, session, updateSessionCwd);
      } else {
        try {
          const homeDir = (await invoke('get_home_directory')) as string;
          await handleChangeDirectory(homeDir, terminal, session, updateSessionCwd);
        } catch {
          safeTermWrite(terminal, `\x1b[31mError: Could not get home directory\x1b[0m\r\n`);
          await displayPrompt(terminal, session);
        }
      }
      return;
    }

    // Built-in: pwd
    if (command === 'pwd') {
      const projectPath = getContainerProjectPath();
      if (isProjectIsolated() && projectPath) {
        let virtualPath = '/';
        if (session.cwd === projectPath) {
          virtualPath = '/';
        } else {
          const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/';
          if (session.cwd.startsWith(prefix)) {
            virtualPath = '/' + session.cwd.slice(prefix.length);
          }
        }
        safeTermWrite(terminal, `${virtualPath}\r\n`);
      } else {
        safeTermWrite(terminal, `${session.cwd}\r\n`);
      }
      await displayPrompt(terminal, session);
      return;
    }

    // External command — stream output in real-time
    cancelledSessions.delete(session.id)
    await runStreamingCommand(command, session.cwd, terminal, session.id);

    // Don't write prompt if Ctrl+C already handled it
    if (!cancelledSessions.has(session.id)) {
      safeTermWrite(terminal, '\r\n');
      await displayPrompt(terminal, session);
    }
    cancelledSessions.delete(session.id)
  } catch (error) {
    if (!cancelledSessions.has(session.id)) {
      safeTermWrite(terminal, `\x1b[31mError: ${error}\x1b[0m\r\n`);
      await displayPrompt(terminal, session);
    }
    cancelledSessions.delete(session.id)
  } finally {
    commandLockRef.current = false;
  }
}

/** Per-session PID tracking for streaming commands — used by Ctrl+C to kill the right process. */
const activeStreamingPids = new Map<string, number>()
/** Per-session cancellation flag — prevents double prompt after Ctrl+C. */
const cancelledSessions = new Set<string>()

/**
 * Kill the active streaming command (called by Ctrl+C handler).
 */
export async function killActiveStreamingCommand(sessionId?: string): Promise<void> {
  // Find the PID for this session, or fall back to any active PID
  let pid: number | undefined
  if (sessionId && activeStreamingPids.has(sessionId)) {
    pid = activeStreamingPids.get(sessionId)
    activeStreamingPids.delete(sessionId)
  } else if (activeStreamingPids.size > 0) {
    // Fallback: kill the first (only matters for single-tab usage)
    const [key, val] = activeStreamingPids.entries().next().value!
    pid = val
    activeStreamingPids.delete(key)
  }

  if (pid) {
    if (sessionId) cancelledSessions.add(sessionId)
    try {
      await invoke('execute_command', {
        command: `kill -TERM -- -${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`,
        cwd: '/',
        timeoutSecs: 3,
      })
    } catch { /* process may have already exited */ }
  }
}

/**
 * Spawn a command and stream its output line-by-line to the terminal.
 * Returns a promise that resolves when the command exits.
 */
async function runStreamingCommand(
  command: string,
  cwd: string,
  terminal: XTerm,
  sessionId?: string
): Promise<void> {
  let pid = 0
  let done!: () => void
  const donePromise = new Promise<void>(resolve => { done = resolve })

  // Set up listeners BEFORE spawning
  const unOutput = await listen<{ pid: number; stream: string; data: string }>(
    'cmd-output',
    (event) => {
      if (sessionId && cancelledSessions.has(sessionId)) return
      if (pid !== 0 && event.payload.pid !== pid) return
      // Write raw chunks directly — xterm handles \r (carriage return)
      // and \n (line feed) natively, including progress bar redraws.
      safeTermWrite(terminal, event.payload.data)
    }
  )

  const unExit = await listen<{ pid: number; code: number }>(
    'cmd-exit',
    (event) => {
      if (pid !== 0 && event.payload.pid !== pid) return
      // Don't show exit code after Ctrl+C (typically 143/SIGTERM) — user already saw ^C
      if (event.payload.code !== 0 && !(sessionId && cancelledSessions.has(sessionId))) {
        safeTermWrite(terminal, `\x1b[31mProcess exited with code ${event.payload.code}\x1b[0m\r\n`)
      }
      done()
    }
  )

  try {
    // Spawn the process — events will start flowing
    pid = await invoke<number>('run_streaming_command', { command, cwd })
    if (sessionId) activeStreamingPids.set(sessionId, pid)

    // Wait for the command to finish
    await donePromise
  } finally {
    if (sessionId) activeStreamingPids.delete(sessionId)
    unOutput()
    unExit()
  }
}
