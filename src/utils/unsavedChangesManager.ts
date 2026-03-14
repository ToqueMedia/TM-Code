import { useEditorRepository } from '../stores/editorStore';

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
      if (this.hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = '';
        return '';
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

  hasUnsavedChanges(): boolean {
    const { openFiles } = useEditorRepository.getState();
    return openFiles.some(f => f.isDirty);
  }
}
