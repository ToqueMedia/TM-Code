import { watch, WatchEvent } from '@tauri-apps/plugin-fs';

export interface FileEvent {
  type: 'create' | 'update' | 'delete' | 'rename';
  path: string;
  oldPath?: string;
}

export class FileWatcher {
  private watchers: Map<string, () => void> = new Map();

  async watch(path: string, callback: (event: FileEvent) => void): Promise<() => void> {
    try {
      // Use Tauri's file system watcher
      const unwatch = await watch(
        path,
        (event: WatchEvent) => {
          // Convert Tauri fs events to our FileEvent format
          const fileEvent: FileEvent = {
            type: this.convertEventType(event.type as string),
            path: event.paths[0]
          };
          
          // Handle rename events which have oldPath
          if ((event.type as any).type === 'rename' && event.paths.length > 1) {
            fileEvent.oldPath = event.paths[1];
          }
          
          callback(fileEvent);
        },
        {
          recursive: true
        }
      );
      
      // Store the unwatch function for cleanup
      this.watchers.set(path, unwatch);
      
      // Return cleanup function
      return () => {
        unwatch();
        this.watchers.delete(path);
      };
    } catch (error: unknown) {
      console.error('Failed to watch path:', error);
      // Return a no-op cleanup function in case of error
      return () => {};
    }
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