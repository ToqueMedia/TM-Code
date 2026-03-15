/**
 * Terminal input event handlers: keyboard shortcuts, history navigation,
 * search mode, tab completion, and data input handling.
 */
import { Terminal as XTerm } from '@xterm/xterm';
import TerminalService from '@/services/terminalService';
import { displayPrompt, executeCommand as execCmd, type TerminalSessionInfo } from './terminalCommands';

interface SetupInputParams {
  terminal: XTerm;
  session: TerminalSessionInfo | undefined;
  sessionRef?: React.MutableRefObject<TerminalSessionInfo | undefined>;
  commandLockRef: React.MutableRefObject<boolean>;
  xtermRef: React.MutableRefObject<XTerm | null>;
  updateSessionCwd: (id: string, cwd: string) => void;
}

/** Helper to clear N characters from the terminal line. */
function clearChars(terminal: XTerm, count: number) {
  for (let i = 0; i < count; i++) terminal.write('\b \b');
}

/** Replace the current line content with a new value. */
function replaceCurrentLine(terminal: XTerm, currentLine: string, newLine: string) {
  clearChars(terminal, currentLine.length);
  terminal.write(newLine);
  return newLine;
}

/**
 * Wire up all input handling on the given XTerm terminal instance.
 * Manages command line editing, history, reverse search, and tab completion.
 */
export function setupTerminalInput({
  terminal, session, sessionRef, commandLockRef, xtermRef, updateSessionCwd,
}: SetupInputParams): void {
  // Use sessionRef if provided for always-fresh session, otherwise fall back to captured value
  const getSession = () => sessionRef?.current ?? session;
  let currentLine = '';
  let commandHistory: string[] = [];
  let historyIndex = -1;
  let searchMode = false;
  let searchTerm = '';

  terminal.onData(async (data) => {
    if (commandLockRef.current) return;
    const code = data.charCodeAt(0);
    const currentSession = getSession();

    if (code === 13) { // Enter
      if (searchMode) {
        searchMode = false;
        if (searchTerm.trim()) {
          const found = commandHistory.find(cmd => cmd.includes(searchTerm));
          if (found) {
            currentLine = found;
            terminal.write(`\r\x1b[K`);
            await displayPrompt(terminal, currentSession);
            terminal.write(currentLine);
          } else {
            terminal.write('\r\x1b[Knot found');
            setTimeout(async () => {
              terminal.write('\r\x1b[K');
              await displayPrompt(terminal, getSession());
            }, 1000);
          }
        }
        searchTerm = '';
      } else if (currentLine.trim()) {
        if (!commandHistory.includes(currentLine.trim())) {
          commandHistory.push(currentLine.trim());
          if (commandHistory.length > 100) commandHistory.shift();
        }
        historyIndex = -1;
        if (currentSession) {
          await execCmd(currentLine.trim(), terminal, currentSession, updateSessionCwd, commandLockRef, xtermRef);
        }
        currentLine = '';
      } else {
        terminal.write('\r\n');
        await displayPrompt(terminal, currentSession);
      }
    } else if (code === 127) { // Backspace
      if (searchMode && searchTerm.length > 0) {
        searchTerm = searchTerm.slice(0, -1);
        terminal.write('\b \b');
      } else if (!searchMode && currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        terminal.write('\b \b');
      }
    } else if (code === 27) { // Escape
      return;
    } else if (code >= 32 && code < 127) {
      if (searchMode) { searchTerm += data; } else { currentLine += data; }
      terminal.write(data);
    }
  });

  terminal.onKey(async ({ domEvent: ev }) => {
    if (ev.code === 'ArrowUp') { // History up
      ev.preventDefault();
      if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
        historyIndex++;
        currentLine = replaceCurrentLine(terminal, currentLine, commandHistory[commandHistory.length - 1 - historyIndex]);
      }
      return;
    }
    if (ev.code === 'ArrowDown') { // History down
      ev.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        currentLine = replaceCurrentLine(terminal, currentLine, commandHistory[commandHistory.length - 1 - historyIndex]);
      } else if (historyIndex === 0) {
        historyIndex = -1;
        currentLine = replaceCurrentLine(terminal, currentLine, '');
      }
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyC') { // Cancel
      terminal.write('\r\n^C\r\n');
      await displayPrompt(terminal, getSession());
      currentLine = ''; historyIndex = -1; commandLockRef.current = false;
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyL') { // Clear screen
      terminal.clear(); await displayPrompt(terminal, getSession());
      currentLine = ''; historyIndex = -1;
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyR') { // Reverse search
      ev.preventDefault();
      if (!searchMode) { searchMode = true; terminal.write('\r\x1b[K(reverse-i-search): '); }
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyU') { // Clear line
      ev.preventDefault(); clearChars(terminal, currentLine.length); currentLine = '';
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyA') { // Beginning of line
      ev.preventDefault();
      for (let i = 0; i < currentLine.length; i++) terminal.write('\b');
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyE') { // End of line
      ev.preventDefault(); terminal.write(currentLine);
      return;
    }
    if (ev.ctrlKey && (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight')) { // Word nav
      ev.preventDefault();
      return;
    }
    if (ev.code === 'Tab') { // Tab completion
      ev.preventDefault();
      if (!currentLine.trim()) return;
      try {
        const s = getSession();
        const completions = await TerminalService.shared.getCompletions(currentLine.trim(), s?.cwd);
        if (completions.length === 1) {
          const words = currentLine.trim().split(' ');
          words[words.length - 1] = completions[0];
          currentLine = replaceCurrentLine(terminal, currentLine, words.join(' '));
        } else if (completions.length > 1) {
          terminal.write('\r\n' + completions.join('  ') + '\r\n');
          await displayPrompt(terminal, s);
          terminal.write(currentLine);
        }
      } catch { /* Silent fail */ }
      return;
    }
  });

  displayPrompt(terminal, getSession());
}
