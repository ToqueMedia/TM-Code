import { useProjectStore } from '../stores/projectStore';

export class UnsavedChangesManager {
  private static instance: UnsavedChangesManager;
  private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

  private constructor() {}

  static getInstance(): UnsavedChangesManager {
    if (!UnsavedChangesManager.instance) {
      UnsavedChangesManager.instance = new UnsavedChangesManager();
    }
    return UnsavedChangesManager.instance;
  }

  enable(): void {
    if (this.beforeUnloadHandler) return;

    this.beforeUnloadHandler = (e: BeforeUnloadEvent) => {
      const { unsavedChanges } = useProjectStore.getState();
      const hasUnsavedChanges = Object.values(unsavedChanges).some(Boolean);
      
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome
        return ''; // Required for other browsers
      }
    };

    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }

  disable(): void {
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }
}