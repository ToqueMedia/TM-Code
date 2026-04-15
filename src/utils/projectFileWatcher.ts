import { FileWatcher, FileEvent } from './fileWatcher';
import { useEditorRepository } from '../stores/editorStore';
import { useFileTreeRepository } from '../stores/fileTreeStore';
import { logger } from './logger';

export class ProjectFileWatcher {
  private fileWatcher: FileWatcher;
  private unwatch: (() => void) | null = null;

  constructor() {
    this.fileWatcher = new FileWatcher();
  }

  async startWatching(projectPath: string) {
    // Stop watching any previous project
    this.stopWatching();

    // Safety guard: refuse to watch overly broad paths (home dir, drive root, etc.).
    // Watching /Users/ithustle recursively with FSEvents would scan millions of files
    // and cause an immediate app freeze + CPU storm.
    // A valid project path must be at least 3 components deep on Unix: /Users/name/project
    const normalised = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
    const depth = normalised.split('/').filter(Boolean).length;
    if (depth < 3) {
      logger.warn('file-watcher', `Refusing to watch broad path (depth=${depth}): ${projectPath}. Open a project subdirectory instead.`);
      this.unwatch = () => {};
      return;
    }

    try {
      // Start watching the project directory
      this.unwatch = await this.fileWatcher.watch(projectPath, this.handleFileEvent.bind(this));
      logger.info('file-watcher', `Started watching project: ${projectPath}`);
    } catch (error: unknown) {
      logger.warn('file-watcher', 'Failed to start file watching (falling back to no-watch mode)', error);
      // Set a no-op unwatch function so stopWatching() doesn't break
      this.unwatch = () => {
        logger.fileWatcher('No-op unwatch called');
      };
    }
  }

  stopWatching() {
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
  }

  private handleFileEvent(event: FileEvent) {
    try {
      logger.fileWatcher('File event detected', event);
      
      // Handle different types of file events
      switch (event.type) {
        case 'create':
          // A new file was created - we might want to refresh the file tree
          this.refreshFileTree();
          break;
          
        case 'update':
          // A file was modified
          this.handleFileUpdate(event.path);
          break;
          
        case 'delete':
          // A file was deleted
          this.handleFileDelete(event.path);
          break;
          
        case 'rename':
          // A file was renamed
          if (event.oldPath) {
            this.handleFileRename(event.oldPath, event.path);
          }
          break;
      }
    } catch (error: unknown) {
      logger.error('file-watcher', 'Error handling file event', error);
    }
  }

  private handleFileUpdate(filePath: string) {
    // If this file is currently open in the editor, we might want to notify the user
    // or automatically reload it (depending on user preferences)
    const editorStore = useEditorRepository.getState();
    const isOpen = editorStore.openFiles.some(file => file.path === filePath);
    
    if (isOpen) {
      // For now, we'll just log it
      logger.info('file-watcher', `Open file was modified externally: ${filePath}`);
      // In a real implementation, we might show a notification or prompt the user
    }
  }

  private handleFileDelete(filePath: string) {
    // If this file is currently open, close it
    const editorStore = useEditorRepository.getState();
    const isOpen = editorStore.openFiles.some(file => file.path === filePath);
    
    if (isOpen) {
      editorStore.closeFile(filePath);
      logger.info('file-watcher', `Closed deleted file: ${filePath}`);
    }
    
    // Refresh the file tree
    this.refreshFileTree();
  }

  private handleFileRename(oldPath: string, newPath: string) {
    const editorStore = useEditorRepository.getState();
    const wasOpen = editorStore.openFiles.some(file => file.path === oldPath);

    if (wasOpen) {
      // Use renameOpenFile to update in-place instead of close+open which loses state
      editorStore.renameOpenFile(oldPath, newPath);
      logger.info('file-watcher', `Renamed file from ${oldPath} to ${newPath}`);
    }

    // Refresh the file tree
    this.refreshFileTree();
  }

  private refreshFileTree() {
    useFileTreeRepository.getState().refresh().catch(err => {
      logger.error('file-watcher', 'Failed to refresh file tree:', err);
    });
  }
}