import { useProjectStore } from '../stores/projectStore';
import { useEditorRepository } from '../stores/editorStore';
import { logger } from './logger';

export class WindowTitleManager {
  private static instance: WindowTitleManager;
  private unsubscribeProject: (() => void) | null = null;
  private unsubscribeEditor: (() => void) | null = null;

  private constructor() {}

  static getInstance(): WindowTitleManager {
    if (!WindowTitleManager.instance) {
      WindowTitleManager.instance = new WindowTitleManager();
    }
    return WindowTitleManager.instance;
  }

  startManaging() {
    this.unsubscribeProject = useProjectStore.subscribe(() => {
      this.updateWindowTitle();
    });

    this.unsubscribeEditor = useEditorRepository.subscribe(() => {
      this.updateWindowTitle();
    });

    // Initial update
    this.updateWindowTitle();
  }

  stopManaging() {
    if (this.unsubscribeProject) {
      this.unsubscribeProject();
      this.unsubscribeProject = null;
    }
    if (this.unsubscribeEditor) {
      this.unsubscribeEditor();
      this.unsubscribeEditor = null;
    }
  }

  private updateWindowTitle() {
    try {
      const { currentProject, cmdModeProjectPath } = useProjectStore.getState();
      const { activeFile, openFiles } = useEditorRepository.getState();

      if (cmdModeProjectPath) {
        const folderName = cmdModeProjectPath.split(/[\/\\]/).pop() || cmdModeProjectPath;
        document.title = `${folderName} [CMD Mode] - TM Code`;
        return;
      }

      if (!currentProject) {
        document.title = 'TM Code';
        return;
      }

      const projectName = currentProject.name;
      let fileName = '';
      let hasUnsavedChanges = false;

      if (activeFile) {
        fileName = activeFile.split('/').pop() || activeFile;
        const openFile = openFiles.find(f => f.path === activeFile);
        if (openFile?.isDirty) {
          hasUnsavedChanges = true;
        }
      }

      let title = projectName;
      if (fileName) {
        title = `${projectName} - ${fileName}`;
      }
      if (hasUnsavedChanges) {
        title = `• ${title}`;
      }
      title = `${title} - TM Code`;

      document.title = title;
    } catch (error: unknown) {
      logger.error('ui', 'Error updating window title:', error);
      document.title = 'TM Code';
    }
  }
}
