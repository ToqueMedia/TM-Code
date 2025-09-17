import type { FileTreeNode } from '../types/fileTree';
import { FileWatcher } from '../utils/fileWatcher';

interface FileTreeUpdateCallback {
  (updatedNode: FileTreeNode): void;
}

class FileWatcherService {
  private static instance: FileWatcherService;
  private fileWatcher: FileWatcher;
  private fileTreeUpdateCallback: FileTreeUpdateCallback | null = null;
  private cleanupFunctions: Map<string, () => void> = new Map();

  private constructor() {
    this.fileWatcher = new FileWatcher();
  }

  static getInstance(): FileWatcherService {
    if (!FileWatcherService.instance) {
      FileWatcherService.instance = new FileWatcherService();
    }
    return FileWatcherService.instance;
  }

  setFileTreeUpdateCallback(callback: (updatedNode: FileTreeNode) => void) {
    this.fileTreeUpdateCallback = callback;
  }

  async watchDirectory(path: string) {
    try {
      // Stop watching if already watching
      this.unwatchDirectory(path);
      
      console.log(`Watching directory: ${path}`);
      
      // Use the actual Tauri file watcher
      const cleanup = await this.fileWatcher.watch(path, (event) => {
        console.log(`File event: ${event.type} - ${event.path}`);
        // In a real implementation, we would update the file tree store directly
      });
      
      this.cleanupFunctions.set(path, cleanup);
      return cleanup;
    } catch (error) {
      console.error(`Failed to watch directory ${path}:`, error);
      throw error;
    }
  }

  unwatchDirectory(path: string) {
    const cleanup = this.cleanupFunctions.get(path);
    if (cleanup) {
      cleanup();
      this.cleanupFunctions.delete(path);
    }
  }

  unwatchAll() {
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions.clear();
  }
}

export default FileWatcherService;