/**
 * Terminal input event handlers: keyboard shortcuts, history navigation,
 * search mode, tab completion, and data input handling.
 */
import { Terminal as XTerm } from '@xterm/xterm';
import TerminalService from '@/services/terminalService';
import { displayPrompt, executeCommand as execCmd, killActiveStreamingCommand, type TerminalSessionInfo } from './terminalCommands';

interface SetupInputParams {
  terminal: XTerm;
  session: TerminalSessionInfo | undefined;
  sessionRef?: React.MutableRefObject<TerminalSessionInfo | undefined>;
  commandLockRef: React.MutableRefObject<boolean>;
  xtermRef: React.MutableRefObject<XTerm | null>;
  updateSessionCwd: (id: string, cwd: string) => void;
}

/** Find the longest common prefix among an array of strings. */
function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
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
  let cursorPos = 0; // position within currentLine
  let commandHistory: string[] = [];
  let historyIndex = -1;
  let searchMode = false;
  let searchTerm = '';

  /** Redraw the current line from cursor to end (after insert/delete in middle) */
  function redrawFromCursor() {
    // Save cursor, write rest of line, clear to end, restore cursor
    const rest = currentLine.slice(cursorPos);
    terminal.write(rest + '\x1b[K'); // write rest + clear to end of line
    // Move cursor back to cursorPos
    for (let i = 0; i < rest.length; i++) terminal.write('\b');
  }

  /** Replace the entire current line and put cursor at end */
  function setLine(newLine: string) {
    // Move cursor to start of current line text
    for (let i = 0; i < cursorPos; i++) terminal.write('\b');
    // Clear from start to end
    terminal.write('\x1b[K');
    // Write new line
    terminal.write(newLine);
    currentLine = newLine;
    cursorPos = newLine.length;
  }

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
            cursorPos = found.length;
            terminal.write(`\r\x1b[K`);
            await displayPrompt(terminal, currentSession);
            terminal.write(currentLine);
          } else {
            currentLine = ''; cursorPos = 0;
            terminal.write('\r\x1b[Knot found');
            setTimeout(async () => {
              terminal.write('\r\x1b[K');
              await displayPrompt(terminal, getSession());
            }, 1000);
          }
        } else {
          cursorPos = 0;
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
        currentLine = ''; cursorPos = 0;
      } else {
        terminal.write('\r\n');
        await displayPrompt(terminal, currentSession);
        cursorPos = 0;
      }
    } else if (code === 127) { // Backspace
      if (searchMode && searchTerm.length > 0) {
        searchTerm = searchTerm.slice(0, -1);
        terminal.write('\b \b');
      } else if (!searchMode && cursorPos > 0) {
        currentLine = currentLine.slice(0, cursorPos - 1) + currentLine.slice(cursorPos);
        cursorPos--;
        terminal.write('\b');
        redrawFromCursor();
      }
    } else if (code === 27) { // Escape sequences (arrows etc.) — let onKey handle them
      return;
    } else if (code >= 32 && code < 127) {
      if (searchMode) {
        searchTerm += data;
      } else {
        // Insert at cursor position
        currentLine = currentLine.slice(0, cursorPos) + data + currentLine.slice(cursorPos);
        cursorPos++;
      }
      terminal.write(data);
      if (!searchMode && cursorPos < currentLine.length) {
        redrawFromCursor();
      }
    }
  });

  terminal.onKey(async ({ domEvent: ev }) => {
    if (ev.code === 'ArrowUp') { // History up
      ev.preventDefault();
      if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
        historyIndex++;
        setLine(commandHistory[commandHistory.length - 1 - historyIndex]);
      }
      return;
    }
    if (ev.code === 'ArrowDown') { // History down
      ev.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        setLine(commandHistory[commandHistory.length - 1 - historyIndex]);
      } else if (historyIndex === 0) {
        historyIndex = -1;
        setLine('');
      }
      return;
    }
    if (ev.code === 'ArrowLeft') { // Move cursor left
      ev.preventDefault();
      if (cursorPos > 0) {
        cursorPos--;
        terminal.write('\x1b[D'); // CSI cursor left
      }
      return;
    }
    if (ev.code === 'ArrowRight') { // Move cursor right
      ev.preventDefault();
      if (cursorPos < currentLine.length) {
        cursorPos++;
        terminal.write('\x1b[C'); // CSI cursor right
      }
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyC') { // Cancel
      const s = getSession();
      await killActiveStreamingCommand(s?.id);
      terminal.write('\r\n^C\r\n');
      await displayPrompt(terminal, s);
      currentLine = ''; cursorPos = 0; historyIndex = -1; commandLockRef.current = false;
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyL') { // Clear screen
      terminal.clear(); await displayPrompt(terminal, getSession());
      currentLine = ''; cursorPos = 0; historyIndex = -1;
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyR') { // Reverse search
      ev.preventDefault();
      if (!searchMode) { searchMode = true; terminal.write('\r\x1b[K(reverse-i-search): '); }
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyU') { // Kill backward to beginning of line
      ev.preventDefault();
      if (cursorPos > 0) {
        const afterCursor = currentLine.slice(cursorPos);
        for (let i = 0; i < cursorPos; i++) terminal.write('\b');
        terminal.write('\x1b[K');
        if (afterCursor.length > 0) {
          terminal.write(afterCursor + '\x1b[K');
          for (let i = 0; i < afterCursor.length; i++) terminal.write('\b');
        }
        currentLine = afterCursor;
        cursorPos = 0;
      }
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyA') { // Beginning of line
      ev.preventDefault();
      for (let i = 0; i < cursorPos; i++) terminal.write('\b');
      cursorPos = 0;
      return;
    }
    if (ev.ctrlKey && ev.code === 'KeyE') { // End of line
      ev.preventDefault();
      const remaining = currentLine.slice(cursorPos);
      terminal.write(remaining);
      cursorPos = currentLine.length;
      return;
    }
    if (ev.ctrlKey && ev.code === 'ArrowLeft') { // Word nav left
      ev.preventDefault();
      // Move to previous word boundary
      while (cursorPos > 0 && currentLine[cursorPos - 1] === ' ') { cursorPos--; terminal.write('\x1b[D'); }
      while (cursorPos > 0 && currentLine[cursorPos - 1] !== ' ') { cursorPos--; terminal.write('\x1b[D'); }
      return;
    }
    if (ev.ctrlKey && ev.code === 'ArrowRight') { // Word nav right
      ev.preventDefault();
      while (cursorPos < currentLine.length && currentLine[cursorPos] !== ' ') { cursorPos++; terminal.write('\x1b[C'); }
      while (cursorPos < currentLine.length && currentLine[cursorPos] === ' ') { cursorPos++; terminal.write('\x1b[C'); }
      return;
    }
    if (ev.code === 'Delete') { // Delete key (forward delete)
      ev.preventDefault();
      if (cursorPos < currentLine.length) {
        currentLine = currentLine.slice(0, cursorPos) + currentLine.slice(cursorPos + 1);
        redrawFromCursor();
      }
      return;
    }
    if (ev.code === 'Home') { // Home key
      ev.preventDefault();
      for (let i = 0; i < cursorPos; i++) terminal.write('\b');
      cursorPos = 0;
      return;
    }
    if (ev.code === 'End') { // End key
      ev.preventDefault();
      const remaining = currentLine.slice(cursorPos);
      terminal.write(remaining);
      cursorPos = currentLine.length;
      return;
    }
    if (ev.code === 'Tab') { // Tab completion
      ev.preventDefault();
      if (!currentLine.trim()) return;
      try {
        const s = getSession();
        const words = currentLine.split(' ');
        const lastWord = words[words.length - 1];
        const completions = await TerminalService.shared.getCompletions(lastWord, s?.cwd);

        if (completions.length === 1) {
          // Single match — replace last word with completion
          words[words.length - 1] = completions[0];
          // Add space after non-directory completions
          const completed = words.join(' ') + (completions[0].endsWith('/') ? '' : ' ');
          currentLine = replaceCurrentLine(terminal, currentLine, completed);
        } else if (completions.length > 1) {
          // Multiple matches — find common prefix and apply it
          const commonPrefix = findCommonPrefix(completions);
          if (commonPrefix.length > lastWord.length) {
            // Extend to common prefix
            words[words.length - 1] = commonPrefix;
            currentLine = replaceCurrentLine(terminal, currentLine, words.join(' '));
          } else {
            // Show all options
            terminal.write('\r\n' + completions.join('  ') + '\r\n');
            await displayPrompt(terminal, s);
            terminal.write(currentLine);
          }
        }
      } catch { /* Silent fail */ }
      return;
    }
  });

  displayPrompt(terminal, getSession());
}
