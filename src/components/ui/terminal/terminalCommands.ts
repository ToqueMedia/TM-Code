/**
 * Built-in terminal command handlers (cd, pwd, clear, etc.)
 * and the main command execution dispatcher.
 */

import { Terminal as XTerm } from '@xterm/xterm';
import TerminalService from '@/services/terminalService';
import { invoke } from '@tauri-apps/api/core';
import { formatCommandOutput } from './terminalFormatting';

export interface TerminalSessionInfo {
  id: string;
  name: string;
  cwd: string;
}

/**
 * Get a truncated display path (relative to home if possible).
 */
export async function getDisplayPath(fullPath: string): Promise<string> {
  try {
    const homeDir = await invoke('get_home_directory') as string;
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
 * Write the shell prompt to the terminal.
 */
export async function displayPrompt(
  terminal: XTerm,
  session: TerminalSessionInfo | undefined
): Promise<void> {
  const cwd = session?.cwd || '~';
  const displayPath = await getDisplayPath(cwd);
  terminal.write(
    `\x1b[32m\x1b[1m${session?.name || 'terminal'}\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `
  );
}

/**
 * Handle the `cd` command: resolve the target path and update session cwd.
 */
export async function handleChangeDirectory(
  targetPath: string,
  terminal: XTerm,
  session: TerminalSessionInfo,
  updateSessionCwd: (id: string, cwd: string) => void
): Promise<void> {
  try {
    let resolvedPath = targetPath;

    if (targetPath === '~' || targetPath === '') {
      resolvedPath = await invoke('get_home_directory') as string;
    } else if (targetPath === '..') {
      const pathParts = session.cwd.split('/').filter(part => part.length > 0);
      if (pathParts.length > 0) {
        pathParts.pop();
        resolvedPath = '/' + pathParts.join('/');
        if (resolvedPath === '/') resolvedPath = '/';
      } else {
        resolvedPath = '/';
      }
    } else if (targetPath === '.') {
      resolvedPath = session.cwd;
    } else if (!targetPath.startsWith('/')) {
      resolvedPath = session.cwd + '/' + targetPath;
    }

    // Normalize path (remove double slashes, etc.)
    resolvedPath = resolvedPath.replace(/\/+/g, '/');
    if (resolvedPath.length > 1 && resolvedPath.endsWith('/')) {
      resolvedPath = resolvedPath.slice(0, -1);
    }

    // Check if directory exists by trying to list it
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
      try {
        const homeDir = await invoke('get_home_directory') as string;
        await handleChangeDirectory(homeDir, terminal, session, updateSessionCwd);
        return;
      } catch (error) {
        terminal.write(`\x1b[31mError: Could not get home directory\x1b[0m\r\n`);
        await displayPrompt(terminal, session);
        return;
      }
    }

    // Built-in: pwd
    if (command === 'pwd') {
      terminal.write(`${session.cwd}\r\n`);
      await displayPrompt(terminal, session);
      return;
    }

    // External command
    const result = await TerminalService.shared.executeCommand(
      command,
      session.cwd
    );

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
