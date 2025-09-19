import { logger } from './logger';

export interface FileEvent {
  type: 'create' | 'update' | 'delete' | 'rename';
  path: string;
  oldPath?: string;
}

export class FileWatcher {
  private watchers: Map<string, () => void> = new Map();
  private isWatchingSupported: boolean | null = null;

  async watch(path: string, callback: (event: FileEvent) => void): Promise<() => void> {
    // Check if file watching is supported
    if (this.isWatchingSupported === null) {
      this.isWatchingSupported = await this.checkWatchSupport();
    }

    if (!this.isWatchingSupported) {
      logger.warn('file-watcher', 'Native file watching is not supported, using fallback');
      // Use polling fallback for non-Tauri environments
      const cleanup = this.createPollingWatcher(path, callback);
      this.watchers.set(path, cleanup);
      return cleanup;
    }

    try {
      // Import watch dynamically to avoid import errors if the API is not available
      const { watch } = await import('@tauri-apps/plugin-fs');
      
      // Use Tauri's file system watcher
      const unwatch = await watch(
        path,
        (event: any) => {
          try {
            // Convert Tauri fs events to our FileEvent format
            const fileEvent: FileEvent = {
              type: this.convertEventType(event.type),
              path: Array.isArray(event.paths) ? event.paths[0] : event.path || path
            };
            
            // Handle rename events which have oldPath
            if (event.type === 'rename' && event.paths && event.paths.length > 1) {
              fileEvent.oldPath = event.paths[1];
            }
            
            callback(fileEvent);
          } catch (callbackError) {
            logger.error('file-watcher', 'Error in file watch callback', callbackError);
          }
        },
        {
          recursive: true
        }
      );
      
      // Store the unwatch function for cleanup
      this.watchers.set(path, unwatch);
      
      // Return cleanup function
      return () => {
        try {
          unwatch();
        } catch (unwatchError) {
          logger.warn('file-watcher', 'Error unwatching path', unwatchError);
        }
        this.watchers.delete(path);
      };
    } catch (error: unknown) {
      logger.error('file-watcher', 'Failed to watch path', error);
      this.isWatchingSupported = false;
      // Return a no-op cleanup function in case of error
      return () => {};
    }
  }

  private async checkWatchSupport(): Promise<boolean> {
    try {
      // Check if we're running in Tauri environment
      if (typeof window !== 'undefined' && (window as any).__TAURI__) {
        // Try to import the watch function to check if it's available
        const { watch } = await import('@tauri-apps/plugin-fs');
        return typeof watch === 'function';
      }
      return false;
    } catch (error) {
      logger.warn('file-watcher', 'Tauri fs plugin not available', error);
      return false;
    }
  }

  // Fallback implementation for non-Tauri environments
  private createPollingWatcher(_path: string, _callback: (event: FileEvent) => void): () => void {
    logger.info('file-watcher', 'File watching not available in this environment. File changes will not be detected automatically.');
    
    // Instead of aggressive polling that causes performance issues,
    // we'll just return a no-op watcher with much less frequent checks
    let isActive = true;
    
    // Only check every 30 seconds instead of every 2 seconds to reduce performance impact
    const checkInterval = setInterval(() => {
      if (!isActive) return;
      
      // We could implement actual file system checks here if needed,
      // but for now we'll just keep the watcher active without generating events
      // to avoid the excessive logging and performance issues
      
    }, 30000); // Much less frequent polling
    
    // Return cleanup function
    return () => {
      isActive = false;
      clearInterval(checkInterval);
    };
  }

  private convertEventType(kind: string): FileEvent['type'] {
    return kind as FileEvent['type'];
  }

  // Stop watching all paths
  stopAll() {
    this.watchers.forEach(unwatch => unwatch());
    this.watchers.clear();
  }
}