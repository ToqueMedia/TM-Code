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
import { formatCommandOutput } from './terminalFormatting';
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
 *
 * Uses component-aware check: projectPath must match as a complete
 * directory prefix, not just a string prefix.
 * e.g. `/Users/me/project-evil` does NOT match `/Users/me/project`.
 */
function clampToProject(resolvedPath: string, projectPath: string): string {
  if (resolvedPath === projectPath) return resolvedPath;
  // Ensure component boundary: path must continue with '/'
  const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/';
  return resolvedPath.startsWith(prefix) ? resolvedPath : projectPath;
}

/**
 * Write the shell prompt to the terminal.
 *
 * - Docker mode:    `[container] terminal:/src$`
 * - App-level mode: `terminal:/src$` (virtual path, no special badge)
 * - Normal:         `terminal:~/project/src$`
 */
export async function displayPrompt(
  terminal: XTerm,
  session: TerminalSessionInfo | undefined
): Promise<void> {
  const cwd = session?.cwd || '~';
  const displayPath = await getDisplayPath(cwd);
  const name = session?.name || 'terminal';

  if (isContainerActive()) {
    terminal.write(
      `\x1b[35m\x1b[1m[container]\x1b[0m \x1b[32m\x1b[1m${name}\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `
    );
  } else {
    terminal.write(
      `\x1b[32m\x1b[1m${name}\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `
    );
  }
}

/**
 * Handle the `cd` command.
 *
 * When isolated (Docker OR app-level):
 *   - `cd /` and `cd ~` go to project root
 *   - `cd ..` above project root is clamped
 *   - absolute paths are relative to project root
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
      // Isolated mode — all paths relative to project root
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
        // Absolute virtual path → map to host path
        resolvedPath = projectPath + targetPath;
      } else {
        resolvedPath = session.cwd + '/' + targetPath;
      }
    } else {
      // Normal mode
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

    // Normalize
    resolvedPath = resolvedPath.replace(/\/+/g, '/');
    if (resolvedPath.length > 1 && resolvedPath.endsWith('/')) {
      resolvedPath = resolvedPath.slice(0, -1);
    }

    // Verify directory exists (backend handles routing transparently)
    const result = await TerminalService.shared.executeCommand('ls', resolvedPath);

    if (result.success) {
      updateSessionCwd(session.id, resolvedPath);
      await displayPrompt(terminal, { ...session, cwd: resolvedPath });
    } else {
      terminal.write(`\x1b[31mcd: no such file or directory: ${targetPath}\x1b[0m\r\n`);
      await displayPrompt(terminal, session);
    }
  } catch (error) {
    terminal.write(`\x1b[31mcd: ${error}\x1b[0m\r\n`);
    await displayPrompt(terminal, session);
  }
}

/**
 * Execute a command in the terminal: dispatches built-in commands
 * or delegates to the TerminalService for external execution.
 *
 * External commands are transparently routed by the Rust backend:
 *   Docker → docker exec, App-level → host with clamped cwd.
 */
export async function executeCommand(
  command: string,
  terminal: XTerm,
  session: TerminalSessionInfo,
  updateSessionCwd: (id: string, cwd: string) => void,
  commandLockRef: React.MutableRefObject<boolean>,
  xtermRef: React.MutableRefObject<XTerm | null>
): Promise<void> {
  if (commandLockRef.current || !session) return;

  commandLockRef.current = true;

  try {
    terminal.write('\r\n');

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
          terminal.write(`\x1b[31mError: Could not get home directory\x1b[0m\r\n`);
          await displayPrompt(terminal, session);
        }
      }
      return;
    }

    // Built-in: pwd (virtual path when isolated)
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
        terminal.write(`${virtualPath}\r\n`);
      } else {
        terminal.write(`${session.cwd}\r\n`);
      }
      await displayPrompt(terminal, session);
      return;
    }

    // External command — backend routes transparently
    const result = await TerminalService.shared.executeCommand(command, session.cwd);

    if (result.success && result.stdout) {
      const terminalCols = xtermRef.current?.cols || 80;
      const formattedOutput = formatCommandOutput(command, result.stdout, terminalCols);
      terminal.write(formattedOutput);
    } else if (result.stderr) {
      const formattedError = formatCommandOutput(command, result.stderr);
      terminal.write(`\x1b[31m${formattedError}\x1b[0m`);
    }

    terminal.write('\r\n');
    await displayPrompt(terminal, session);
  } catch (error) {
    terminal.write(`\x1b[31mError: ${error}\x1b[0m\r\n$ `);
  } finally {
    commandLockRef.current = false;
  }
}
