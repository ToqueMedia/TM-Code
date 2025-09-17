import { useProjectStore } from '../stores/projectStore';

export class UnsavedChangesManager {
  private static instance: UnsavedChangesManager;
  private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
  private onUnsavedChangesCallback: ((hasUnsaved: boolean) => void) | null = null;

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
    
    // Notify that we have unsaved changes
    this.notifyUnsavedChanges(true);
  }

  disable(): void {
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
    
    // Notify that we no longer have unsaved changes
    this.notifyUnsavedChanges(false);
  }

  setOnUnsavedChangesCallback(callback: (hasUnsaved: boolean) => void): void {
    this.onUnsavedChangesCallback = callback;
  }

  private notifyUnsavedChanges(hasUnsaved: boolean): void {
    if (this.onUnsavedChangesCallback) {
      this.onUnsavedChangesCallback(hasUnsaved);
    }
    
    // Dispatch a custom event for other parts of the app to listen to
    window.dispatchEvent(new CustomEvent('unsavedChangesChange', { 
      detail: { hasUnsavedChanges: hasUnsaved } 
    }));
  }

  hasUnsavedChanges(): boolean {
    const { unsavedChanges } = useProjectStore.getState();
    return Object.values(unsavedChanges).some(Boolean);
  }
}