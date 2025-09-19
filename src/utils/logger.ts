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
      enabledCategories: new Set(['error', 'warn']),
      maxLogsPerSecond: process.env.NODE_ENV === 'development' ? 10 : 3,
      enableConsole: true,
      enableFileWatcher: false, // Disabled by default to reduce noise
      enableThemeLogger: false, // Disabled by default to reduce noise
      enableWindowService: false, // Disabled by default to reduce noise
      enableTerminalFit: false    // Disabled by default to reduce noise
    };

    // In development, allow more verbose logging with categories
    if (process.env.NODE_ENV === 'development') {
      this.config.enabledCategories.add('info');
      this.config.enabledCategories.add('debug');
    }
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(category: string, level: LogLevel): boolean {
    // Check log level
    if (level > this.config.level) {
      return false;
    }

    // Check if category is enabled
    if (!this.config.enabledCategories.has(category)) {
      return false;
    }

    // Special handling for noisy categories
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

  error(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog(category, LogLevel.ERROR)) {
      console.error(this.formatMessage(category, message), ...args);
    }
  }

  warn(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog(category, LogLevel.WARN)) {
      console.warn(this.formatMessage(category, message), ...args);
    }
  }

  info(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog(category, LogLevel.INFO)) {
      console.log(this.formatMessage(category, message), ...args);
    }
  }

  debug(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog(category, LogLevel.DEBUG)) {
      console.log(this.formatMessage(category, message), ...args);
    }
  }

  // Convenience methods for common categories
  fileWatcher(message: string, ...args: any[]): void {
    this.debug('file-watcher', message, ...args);
  }

  theme(message: string, ...args: any[]): void {
    this.debug('theme', message, ...args);
  }

  editor(message: string, ...args: any[]): void {
    this.debug('editor', message, ...args);
  }

  window(message: string, ...args: any[]): void {
    this.debug('window', message, ...args);
  }

  terminal(message: string, ...args: any[]): void {
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

  enableCategory(category: string): void {
    this.config.enabledCategories.add(category);
  }

  disableCategory(category: string): void {
    this.config.enabledCategories.delete(category);
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

// Export singleton instance
export const logger = Logger.getInstance();

// Global convenience functions for debugging in browser console
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).toggleFileWatcherLogs = () => {
    logger.enableFileWatcher(!logger['config'].enableFileWatcher);
    console.log('File watcher logs:', logger['config'].enableFileWatcher ? 'ENABLED' : 'DISABLED');
  };

  (window as any).toggleThemeLogs = () => {
    logger.enableThemeLogger(!logger['config'].enableThemeLogger);
    console.log('Theme logs:', logger['config'].enableThemeLogger ? 'ENABLED' : 'DISABLED');
  };

  (window as any).toggleWindowLogs = () => {
    logger.enableWindowService(!logger['config'].enableWindowService);
    console.log('Window service logs:', logger['config'].enableWindowService ? 'ENABLED' : 'DISABLED');
  };

  (window as any).toggleTerminalFitLogs = () => {
    logger.enableTerminalFit(!logger['config'].enableTerminalFit);
    console.log('Terminal fit logs:', logger['config'].enableTerminalFit ? 'ENABLED' : 'DISABLED');
  };

  (window as any).getLoggerStats = () => {
    const stats = logger.getStats();
    console.table(stats);
    return stats;
  };

  (window as any).silenceLogs = (seconds: number = 30) => {
    logger.silenceFor(seconds * 1000);
    console.log(`Logs silenced for ${seconds} seconds`);
  };

  (window as any).loggerHelp = () => {
    console.log(`
🔧 Logger Debug Commands:
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
export const logError = (category: string, message: string, ...args: any[]) => 
  logger.error(category, message, ...args);

export const logWarn = (category: string, message: string, ...args: any[]) => 
  logger.warn(category, message, ...args);

export const logInfo = (category: string, message: string, ...args: any[]) => 
  logger.info(category, message, ...args);

export const logDebug = (category: string, message: string, ...args: any[]) => 
  logger.debug(category, message, ...args);

// Development helper to toggle verbose logging
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).toggleFileWatcherLogs = () => {
    logger.enableFileWatcher(!logger['config'].enableFileWatcher);
    console.log('File watcher logs:', logger['config'].enableFileWatcher ? 'ENABLED' : 'DISABLED');
  };

  (window as any).toggleThemeLogs = () => {
    logger.enableThemeLogger(!logger['config'].enableThemeLogger);
    console.log('Theme logs:', logger['config'].enableThemeLogger ? 'ENABLED' : 'DISABLED');
  };

  (window as any).getLoggerStats = () => {
    console.table(logger.getStats());
  };
}

export default logger;