import { useEditorRepository } from '../stores/editorStore';
import { UnsavedChangesManager } from '../utils/unsavedChangesManager';

class UnsavedChangesService {
  private static instance: UnsavedChangesService;

  private constructor() {}

  static getInstance(): UnsavedChangesService {
    if (!UnsavedChangesService.instance) {
      UnsavedChangesService.instance = new UnsavedChangesService();
    }
    return UnsavedChangesService.instance;
  }

  markFileAsDirty(_filePath: string): void {
    // isDirty is already tracked inside editorStore (EditorFile.isDirty).
    // This method only needs to sync the UnsavedChangesManager (beforeunload guard).
    const manager = UnsavedChangesManager.getInstance();
    manager.enable();
  }

  markFileAsClean(_filePath: string): void {
    // Check if any files are still dirty via the single source of truth
    if (!this.hasUnsavedChanges()) {
      const manager = UnsavedChangesManager.getInstance();
      manager.disable();
    }
  }

  hasUnsavedChanges(): boolean {
    const { openFiles } = useEditorRepository.getState();
    return openFiles.some(f => f.isDirty);
  }

  getUnsavedFiles(): string[] {
    const { openFiles } = useEditorRepository.getState();
    return openFiles.filter(f => f.isDirty).map(f => f.path);
  }

  reset(): void {
    const manager = UnsavedChangesManager.getInstance();
    manager.disable();
  }
}

export default UnsavedChangesService;
