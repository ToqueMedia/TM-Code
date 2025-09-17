import { useProjectStore } from '../stores/projectStore';
import { useEditorRepository } from '../stores/editorStore';

export class WindowTitleManager {
  private static instance: WindowTitleManager;
  private unsubscribe: (() => void) | null = null;

  private constructor() {}

  static getInstance(): WindowTitleManager {
    if (!WindowTitleManager.instance) {
      WindowTitleManager.instance = new WindowTitleManager();
    }
    return WindowTitleManager.instance;
  }

  startManaging() {
    // Subscribe to store changes
    this.unsubscribe = useProjectStore.subscribe((state) => {
      this.updateWindowTitle(state);
    });
    
    // Also subscribe to editor changes
    useEditorRepository.subscribe(() => {
      const projectState = useProjectStore.getState();
      this.updateWindowTitle(projectState);
    });
    
    // Initial update
    const initialState = useProjectStore.getState();
    this.updateWindowTitle(initialState);
  }

  stopManaging() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private updateWindowTitle(projectState: ReturnType<typeof useProjectStore.getState>) {
    try {
      const { currentProject, activeFile } = projectState;
      const editorState = useEditorRepository.getState();
      
      if (!currentProject) {
        document.title = 'ToqueMedia Studio';
        return;
      }
      
      const projectName = currentProject.name;
      let fileName = '';
      let hasUnsavedChanges = false;
      
      if (activeFile) {
        // Extract file name from path
        fileName = activeFile.split('/').pop() || activeFile;
        
        // Check if file has unsaved changes
        const openFile = editorState.openFiles.find(f => f.path === activeFile);
        if (openFile && openFile.isDirty) {
          hasUnsavedChanges = true;
        }
      }
      
      // Build title
      let title = projectName;
      if (fileName) {
        title = `${projectName} - ${fileName}`;
      }
      
      // Add unsaved changes indicator
      if (hasUnsavedChanges) {
        title = `• ${title}`;
      }
      
      title = `${title} - ToqueMedia Studio`;
      
      document.title = title;
    } catch (error: unknown) {
      console.error('Error updating window title:', error);
      document.title = 'ToqueMedia Studio';
    }
  }
}