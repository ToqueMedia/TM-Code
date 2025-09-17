import { useProjectStore } from '../stores/projectStore';
import { UnsavedChangesManager } from '../utils/unsavedChangesManager';

class UnsavedChangesService {
  private static instance: UnsavedChangesService;
  private notificationCallback: ((message: string, type: 'info' | 'warning' | 'error') => void) | null = null;

  private constructor() {}

  static getInstance(): UnsavedChangesService {
    if (!UnsavedChangesService.instance) {
      UnsavedChangesService.instance = new UnsavedChangesService();
    }
    return UnsavedChangesService.instance;
  }

  setNotificationCallback(callback: (message: string, type: 'info' | 'warning' | 'error') => void): void {
    this.notificationCallback = callback;
  }

  private showNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
    if (this.notificationCallback) {
      this.notificationCallback(message, type);
    } else {
      // Fallback to console
      console.log(`[${type.toUpperCase()}] ${message}`);
    }
  }

  markFileAsDirty(filePath: string): void {
    const { setUnsavedChanges } = useProjectStore.getState();
    setUnsavedChanges(filePath, true);
    
    // Enable unsaved changes manager
    const manager = UnsavedChangesManager.getInstance();
    manager.enable();
    
    this.showNotification(`File ${filePath} has unsaved changes`, 'warning');
  }

  markFileAsClean(filePath: string): void {
    const { setUnsavedChanges } = useProjectStore.getState();
    setUnsavedChanges(filePath, false);
    
    // Check if we still have unsaved changes
    const manager = UnsavedChangesManager.getInstance();
    if (!manager.hasUnsavedChanges()) {
      manager.disable();
    }
    
    this.showNotification(`File ${filePath} saved`, 'info');
  }

  hasUnsavedChanges(): boolean {
    const { unsavedChanges } = useProjectStore.getState();
    return Object.values(unsavedChanges).some(Boolean);
  }

  getUnsavedFiles(): string[] {
    const { unsavedChanges } = useProjectStore.getState();
    return Object.entries(unsavedChanges)
      .filter(([_, hasChanges]) => hasChanges)
      .map(([filePath, _]) => filePath);
  }

  async promptToSaveUnsavedChanges(): Promise<boolean> {
    const unsavedFiles = this.getUnsavedFiles();
    
    if (unsavedFiles.length === 0) {
      return true;
    }
    
    const message = `You have ${unsavedFiles.length} unsaved file(s):
${unsavedFiles.join('\n')}
\nDo you want to save changes before closing?`;
    
    // In a real implementation, you would show a proper dialog
    // For now, we'll use confirm
    return window.confirm(message);
  }

  async saveAllUnsavedFiles(): Promise<void> {
    try {
      const { saveProjectState } = useProjectStore.getState();
      await saveProjectState();
      
      // Mark all files as clean
      const unsavedFiles = this.getUnsavedFiles();
      unsavedFiles.forEach(filePath => {
        this.markFileAsClean(filePath);
      });
      
      this.showNotification('All changes saved successfully', 'info');
    } catch (error) {
      console.error('Failed to save all unsaved files:', error);
      this.showNotification('Failed to save changes', 'error');
      throw error;
    }
  }

  reset(): void {
    // Disable unsaved changes manager
    const manager = UnsavedChangesManager.getInstance();
    manager.disable();
    
    this.showNotification('Unsaved changes tracking reset', 'info');
  }
}

export default UnsavedChangesService;