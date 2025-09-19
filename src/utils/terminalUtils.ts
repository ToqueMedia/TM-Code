import type { Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { logger } from './logger';

/**
 * Safely checks if a terminal is ready for operations like fit()
 */
export function isTerminalReady(terminal: XTerm | null): boolean {
  if (!terminal || !terminal.element) {
    return false;
  }

  try {
    // Check if the internal renderer service is available and has dimensions
    const core = (terminal as any)._core;
    if (!core || !core._renderService || !core._renderService.dimensions) {
      return false;
    }

    // Additional check for the terminal being properly attached to DOM
    return terminal.element.isConnected;
  } catch (error) {
    return false;
  }
}

/**
 * Safely fits a terminal to its container with error handling
 */
export function safeTerminalFit(
  terminal: XTerm | null, 
  fitAddon: FitAddon | null, 
  maxRetries: number = 3
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!terminal || !fitAddon) {
      resolve(false);
      return;
    }

    let retries = 0;
    
    const attemptFit = () => {
      try {
        if (isTerminalReady(terminal)) {
          fitAddon.fit();
          resolve(true);
          return;
        }
      } catch (error) {
        // Only log the error if it's not a common initialization issue
        if (retries === maxRetries - 1) {
          logger.debug('terminal-fit', `Terminal fit failed after ${retries + 1} attempts - terminal may not be fully ready`, error);
        }
      }

      retries++;
      if (retries < maxRetries) {
        // Wait progressively longer with each retry
        setTimeout(attemptFit, Math.min(retries * 100, 500));
      } else {
        // Only warn if this is not the initial fit attempt (which commonly fails)
        // Terminal will still be usable even if fit fails
        resolve(false);
      }
    };

    attemptFit();
  });
}

/**
 * Debounced terminal resize function that's safe to call frequently
 */
export function createDebouncedTerminalResize(
  terminal: XTerm | null,
  fitAddon: FitAddon | null,
  delay: number = 150
): () => void {
  let timeoutRef: NodeJS.Timeout | null = null;

  return () => {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }

    timeoutRef = setTimeout(async () => {
      if (terminal && fitAddon && isTerminalReady(terminal)) {
        try {
          await safeTerminalFit(terminal, fitAddon);
        } catch (error) {
          // Only log terminal resize errors if they're not initialization-related
          logger.debug('terminal-fit', 'Terminal resize failed - terminal may not be ready', error);
        }
      }
      timeoutRef = null;
    }, delay);
  };
}

/**
 * Creates a ResizeObserver that safely resizes terminals
 */
export function createTerminalResizeObserver(
  onResize: () => void
): ResizeObserver {
  return new ResizeObserver((entries) => {
    // Only trigger if we actually have size changes
    for (const entry of entries) {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        onResize();
        break; // Only need to call once per batch
      }
    }
  });
}