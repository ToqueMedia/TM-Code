import { FileWatcher, FileEvent } from './fileWatcher';
import { useEditorRepository } from '../stores/editorStore';

export class ProjectFileWatcher {
  private fileWatcher: FileWatcher;
  private unwatch: (() => void) | null = null;

  constructor() {
    this.fileWatcher = new FileWatcher();
  }

  async startWatching(projectPath: string) {
    // Stop watching any previous project
    this.stopWatching();
    
    try {
      // Start watching the project directory
      this.unwatch = await this.fileWatcher.watch(projectPath, this.handleFileEvent.bind(this));
      console.log(`Started watching project: ${projectPath}`);
    } catch (error: unknown) {
      console.warn('Failed to start file watching (falling back to no-watch mode):', error);
      // Set a no-op unwatch function so stopWatching() doesn't break
      this.unwatch = () => {
        console.log('No-op unwatch called');
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
      console.log('File event detected:', event);
      
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
      console.error('Error handling file event:', error);
    }
  }

  private handleFileUpdate(filePath: string) {
    // If this file is currently open in the editor, we might want to notify the user
    // or automatically reload it (depending on user preferences)
    const editorStore = useEditorRepository.getState();
    const isOpen = editorStore.openFiles.some(file => file.path === filePath);
    
    if (isOpen) {
      // For now, we'll just log it
      console.log(`Open file was modified externally: ${filePath}`);
      // In a real implementation, we might show a notification or prompt the user
    }
  }

  private handleFileDelete(filePath: string) {
    // If this file is currently open, close it
    const editorStore = useEditorRepository.getState();
    const isOpen = editorStore.openFiles.some(file => file.path === filePath);
    
    if (isOpen) {
      editorStore.closeFile(filePath);
      console.log(`Closed deleted file: ${filePath}`);
    }
    
    // Refresh the file tree
    this.refreshFileTree();
  }

  private handleFileRename(oldPath: string, newPath: string) {
    // If the old file was open, update its path
    const editorStore = useEditorRepository.getState();
    const wasOpen = editorStore.openFiles.some(file => file.path === oldPath);
    
    if (wasOpen) {
      // Close the old file and open the new one
      editorStore.closeFile(oldPath);
      
      // If the old file was the active file, set the new file as active
      if (editorStore.activeFile === oldPath) {
        editorStore.setActiveFile(newPath);
      }
      
      console.log(`Renamed file from ${oldPath} to ${newPath}`);
    }
    
    // Refresh the file tree
    this.refreshFileTree();
  }

  private refreshFileTree() {
    // In a real implementation, we would notify the file tree component to refresh
    // For now, we'll just log it
    console.log('File tree refresh needed');
  }
}