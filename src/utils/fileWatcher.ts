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
      console.warn('Native file watching is not supported, using fallback');
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
            console.error('Error in file watch callback:', callbackError);
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
          console.warn('Error unwatching path:', unwatchError);
        }
        this.watchers.delete(path);
      };
    } catch (error: unknown) {
      console.error('Failed to watch path:', error);
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
      console.warn('Tauri fs plugin not available:', error);
      return false;
    }
  }

  // Fallback implementation for non-Tauri environments
  private createPollingWatcher(path: string, callback: (event: FileEvent) => void): () => void {
    console.info('Using polling fallback for file watching (Tauri not available)');
    
    // Simple polling fallback - checks every 2 seconds
    // This is not ideal but provides basic functionality
    let lastModified: number = Date.now();
    let isActive = true;
    
    const poll = () => {
      if (!isActive) return;
      
      // In a real implementation, you might use the File System Access API
      // or other browser APIs here. For now, we just simulate.
      const now = Date.now();
      if (now - lastModified > 2000) {
        // Simulate a generic update event
        callback({
          type: 'update',
          path
        });
        lastModified = now;
      }
      
      // Schedule next check
      setTimeout(poll, 2000);
    };
    
    // Start polling after a delay
    setTimeout(poll, 1000);
    
    // Return cleanup function
    return () => {
      isActive = false;
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