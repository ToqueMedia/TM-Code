/**
 * Sistema de logging inteligente para ToqueMedia Studio
 * Controla o volume de logs para evitar problemas de performance
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

export interface LoggerConfig {
  level: LogLevel;
  enabledCategories: Set<string>;
  maxLogsPerSecond: number;
  enableConsole: boolean;
  enableFileWatcher: boolean;
  enableThemeLogger: boolean;
  enableWindowService: boolean;
  enableTerminalFit: boolean;
}

class Logger {
  private static instance: Logger;
  private config: LoggerConfig;
  private logCounts: Map<string, { count: number; lastReset: number }> = new Map();
  private readonly RESET_INTERVAL = 1000; // 1 second

  private constructor() {
    this.config = {
      level: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.WARN,
      // enabledCategories is DEPRECATED — the category gate was removed from
      // shouldLog (it was a systemic bug; see shouldLog comment). The Set is
      // kept alive only for getStats() backward compat — it's never checked
      // in the hot path.
      enabledCategories: new Set<string>(),
      maxLogsPerSecond: process.env.NODE_ENV === 'development' ? 10 : 3,
      enableConsole: true,
      enableFileWatcher: false, // Disabled by default to reduce noise
      enableThemeLogger: false, // Disabled by default to reduce noise
      enableWindowService: false, // Disabled by default to reduce noise
      enableTerminalFit: false    // Disabled by default to reduce noise
    };
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(category: string, level: LogLevel): boolean {
    // Check log level — the primary verbosity gate.
    // Production: WARN (only error + warn pass).
    // Development: DEBUG (everything passes).
    if (level > this.config.level) {
      return false;
    }

    // NOTE: the previous `enabledCategories.has(category)` gate was REMOVED
    // because it was a systemic bug. The default set was {'error', 'warn'}
    // (production) / {'error', 'warn', 'info', 'debug'} (dev) — those are
    // LEVEL names, not real category names. None of the 40+ actual categories
    // used in the codebase ('agent', 'chat', 'editor', 'checkpoint', etc.)
    // were in the set. Result: EVERY logger.info/warn/error call with a real
    // category was silently dropped in every environment since the logger's
    // creation. The level check above is the correct verbosity gate; the
    // category filter was redundant (and broken). enableCategory() /
    // disableCategory() are kept as no-ops for backward compatibility.

    // Special handling for noisy categories — opt-OUT mutes for categories
    // that are too verbose even at the enabled log level. These dedicated
    // boolean flags are the correct mechanism for per-category control
    // (unlike the removed enabledCategories gate which was opt-IN).
    if (category === 'file-watcher' && !this.config.enableFileWatcher) {
      return false;
    }

    if (category === 'theme' && !this.config.enableThemeLogger) {
      return false;
    }

    if (category === 'window' && !this.config.enableWindowService) {
      return false;
    }

    if (category === 'terminal-fit' && !this.config.enableTerminalFit) {
      return false;
    }

    // Rate limiting
    const now = Date.now();
    const key = category;
    const logData = this.logCounts.get(key);

    if (!logData) {
      this.logCounts.set(key, { count: 1, lastReset: now });
      return true;
    }

    // Reset count if interval passed
    if (now - logData.lastReset >= this.RESET_INTERVAL) {
      logData.count = 1;
      logData.lastReset = now;
      return true;
    }

    // Check rate limit
    if (logData.count >= this.config.maxLogsPerSecond) {
      return false;
    }

    logData.count++;
    return true;
  }

  private formatMessage(category: string, message: string): string {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    return `[${timestamp}] [${category.toUpperCase()}] ${message}`;
  }

  error(category: string, message: string, ...args: unknown[]): void {
    if (this.shouldLog(category, LogLevel.ERROR)) {
      console.error(this.formatMessage(category, message), ...args);
    }
  }

  warn(category: string, message: string, ...args: unknown[]): void {
    if (this.shouldLog(category, LogLevel.WARN)) {
      console.warn(this.formatMessage(category, message), ...args);
    }
  }

  info(category: string, message: string, ...args: unknown[]): void {
    if (this.shouldLog(category, LogLevel.INFO)) {
      console.log(this.formatMessage(category, message), ...args);
    }
  }

  debug(category: string, message: string, ...args: unknown[]): void {
    if (this.shouldLog(category, LogLevel.DEBUG)) {
      console.log(this.formatMessage(category, message), ...args);
    }
  }

  // Convenience methods for common categories
  fileWatcher(message: string, ...args: unknown[]): void {
    this.debug('file-watcher', message, ...args);
  }

  theme(message: string, ...args: unknown[]): void {
    this.debug('theme', message, ...args);
  }

  editor(message: string, ...args: unknown[]): void {
    this.debug('editor', message, ...args);
  }

  window(message: string, ...args: unknown[]): void {
    this.debug('window', message, ...args);
  }

  terminal(message: string, ...args: unknown[]): void {
    this.info('terminal', message, ...args);
  }

  // Configuration methods
  enableFileWatcher(enable: boolean = true): void {
    this.config.enableFileWatcher = enable;
  }

  enableThemeLogger(enable: boolean = true): void {
    this.config.enableThemeLogger = enable;
  }

  enableWindowService(enable: boolean = true): void {
    this.config.enableWindowService = enable;
  }

  enableTerminalFit(enable: boolean = true): void {
    this.config.enableTerminalFit = enable;
  }

  setLogLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * @deprecated No-op since the enabledCategories gate was removed (it was
   * a systemic bug — see shouldLog comment). Kept for backward compat so
   * existing callers don't crash. New code should NOT call this; use the
   * per-category boolean flags (enableFileWatcher, enableThemeLogger, etc.)
   * for opt-OUT muting of noisy categories.
   */
  enableCategory(_category: string): void {
    // intentional no-op
  }

  /** @deprecated See enableCategory. */
  disableCategory(_category: string): void {
    // intentional no-op
  }

  // Diagnostic method to show current state
  getStats(): { category: string; logsPerSecond: number; enabled: boolean }[] {
    const now = Date.now();
    const stats: { category: string; logsPerSecond: number; enabled: boolean }[] = [];

    this.logCounts.forEach((data, category) => {
      const timeSinceReset = now - data.lastReset;
      const logsPerSecond = timeSinceReset > 0 ? (data.count / timeSinceReset) * 1000 : 0;
      
      stats.push({
        category,
        logsPerSecond: Math.round(logsPerSecond * 100) / 100,
        enabled: this.config.enabledCategories.has(category)
      });
    });

    return stats.sort((a, b) => b.logsPerSecond - a.logsPerSecond);
  }

  // Method to temporarily silence all logs
  private silenceTimer: NodeJS.Timeout | null = null;
  
  silenceFor(milliseconds: number): void {
    const originalLevel = this.config.level;
    this.config.level = LogLevel.ERROR;
    
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    
    this.silenceTimer = setTimeout(() => {
      this.config.level = originalLevel;
      this.silenceTimer = null;
    }, milliseconds);
  }
}

// Augment window for dev debugging helpers
declare global {
  interface Window {
    toggleFileWatcherLogs?: () => void
    toggleThemeLogs?: () => void
    toggleWindowLogs?: () => void
    toggleTerminalFitLogs?: () => void
    getLoggerStats?: () => { category: string; logsPerSecond: number; enabled: boolean }[]
    silenceLogs?: (seconds?: number) => void
    loggerHelp?: () => void
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Global convenience functions for debugging in browser console
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.toggleFileWatcherLogs = () => {
    logger.enableFileWatcher(!logger['config'].enableFileWatcher);
    console.log('File watcher logs:', logger['config'].enableFileWatcher ? 'ENABLED' : 'DISABLED');
  };

  window.toggleThemeLogs = () => {
    logger.enableThemeLogger(!logger['config'].enableThemeLogger);
    console.log('Theme logs:', logger['config'].enableThemeLogger ? 'ENABLED' : 'DISABLED');
  };

  window.toggleWindowLogs = () => {
    logger.enableWindowService(!logger['config'].enableWindowService);
    console.log('Window service logs:', logger['config'].enableWindowService ? 'ENABLED' : 'DISABLED');
  };

  window.toggleTerminalFitLogs = () => {
    logger.enableTerminalFit(!logger['config'].enableTerminalFit);
    console.log('Terminal fit logs:', logger['config'].enableTerminalFit ? 'ENABLED' : 'DISABLED');
  };

  window.getLoggerStats = () => {
    const stats = logger.getStats();
    console.table(stats);
    return stats;
  };

  window.silenceLogs = (seconds: number = 30) => {
    logger.silenceFor(seconds * 1000);
    console.log(`Logs silenced for ${seconds} seconds`);
  };

  window.loggerHelp = () => {
    console.log(`
Logger Debug Commands:
- toggleFileWatcherLogs() - Toggle file watcher logs
- toggleThemeLogs() - Toggle theme logs
- toggleWindowLogs() - Toggle window service logs
- toggleTerminalFitLogs() - Toggle terminal fit logs
- getLoggerStats() - Show logging statistics
- silenceLogs(seconds) - Silence logs temporarily
- loggerHelp() - Show this help
`);
  };
}

// Export convenience functions
export const logError = (category: string, message: string, ...args: unknown[]) =>
  logger.error(category, message, ...args);

export const logWarn = (category: string, message: string, ...args: unknown[]) =>
  logger.warn(category, message, ...args);

export const logInfo = (category: string, message: string, ...args: unknown[]) =>
  logger.info(category, message, ...args);

export const logDebug = (category: string, message: string, ...args: unknown[]) =>
  logger.debug(category, message, ...args);

export default logger;