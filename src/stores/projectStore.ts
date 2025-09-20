import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProjectInfo, RecentProject, ProjectState, WindowState } from '../types/project';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { UnsavedChangesManager } from '../utils/unsavedChangesManager';
import { EditorManager } from '../utils/editorManager';
import { ProjectStatusMonitor } from '../utils/projectStatusMonitor';
import { ProjectFileWatcher } from '../utils/projectFileWatcher';
import { WindowTitleManager } from '../utils/windowTitleManager';
import { useEditorRepository } from './editorStore';
import RecoveryService from '../services/recoveryService';
import WindowService from '../services/windowService';

interface ProjectStore {
  currentProject: ProjectInfo | null;
  recentProjects: RecentProject[];
  openFiles: string[];
  activeFile: string | null;
  unsavedChanges: Record<string, boolean>;
  windowState: WindowState;
  cursorPositions: Record<string, [number, number]>; // line, column
  loading: boolean;
  error: string | null;
  
  // Actions
  openProject: (path: string) => Promise<void>;
  createProject: (path: string, template: string) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  closeProject: () => void;
  addOpenFile: (filePath: string) => void;
  removeOpenFile: (filePath: string) => void;
  setActiveFile: (filePath: string | null) => void;
  setUnsavedChanges: (filePath: string, hasChanges: boolean) => void;
  updateCursorPosition: (filePath: string, line: number, column: number) => void;
  saveProjectState: () => Promise<void>;
  loadProjectState: (projectId: string) => Promise<void>;
  setWindowState: (state: WindowState) => void;
  updateWindowState: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

import { AutoSaveQueue } from '../utils/autoSaveQueue';

// Auto-save queue instance
const autoSaveQueue = AutoSaveQueue.getInstance();

// File watcher instance
const fileWatcher = new ProjectFileWatcher();

// Window title manager instance
const windowTitleManager = WindowTitleManager.getInstance();

// Recovery service instance
const recoveryService = RecoveryService.getInstance();

// Window service instance
const windowService = WindowService.getInstance();

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      currentProject: null,
      recentProjects: [],
      openFiles: [],
      activeFile: null,
      unsavedChanges: {},
      cursorPositions: {},
      windowState: {
        width: 1200,
        height: 800,
        x: 100,
        y: 100,
        maximized: false,
      },
      loading: false,
      error: null,
      
      openProject: async (path: string) => {
        set({ loading: true, error: null });
        try {
          const projectInfo: ProjectInfo = await invoke('open_project', { path });
          set({ 
            currentProject: projectInfo,
            loading: false
          });

          // Clear editor open files when opening a new project
          try { useEditorRepository.getState().closeAllFiles() } catch {}
          
          // Check for recovery state before loading project state
          const hasRecovery = await recoveryService.hasRecoveryState(projectInfo.id);
          if (hasRecovery) {
            console.warn(`Recovery state found for project ${projectInfo.id}. Consider recovering before loading.`);
            // In a real implementation, you might want to prompt the user
          }
          
          // Start monitoring project status
          const monitor = ProjectStatusMonitor.getInstance();
          monitor.startMonitoring();
          
          // Start watching project files
          fileWatcher.startWatching(path);
          
          // Start managing window title
          windowTitleManager.startManaging();
          
          // Load project state if exists
          try {
            await get().loadProjectState(projectInfo.id);
          } catch (error) {
            console.warn('Failed to load project state:', error);
          }
        } catch (error: any) {
          set({ 
            loading: false, 
            error: error.message || 'Failed to open project' 
          });
          throw error;
        }
      },
      
      createProject: async (path: string, template: string) => {
        set({ loading: true, error: null });
        try {
          const projectInfo: ProjectInfo = await invoke('create_project', { path, template });
          set({ 
            currentProject: projectInfo,
            loading: false
          });
          
          // Start monitoring project status
          const monitor = ProjectStatusMonitor.getInstance();
          monitor.startMonitoring();
          
          // Start watching project files
          fileWatcher.startWatching(path);
          
          // Start managing window title
          windowTitleManager.startManaging();
        } catch (error: any) {
          set({ 
            loading: false, 
            error: error.message || 'Failed to create project' 
          });
          throw error;
        }
      },
      
      loadRecentProjects: async () => {
        set({ loading: true, error: null });
        try {
          const recentProjects: RecentProject[] = await invoke('get_recent_projects');
          set({ 
            recentProjects,
            loading: false
          });
        } catch (error: any) {
          set({ 
            loading: false, 
            error: error.message || 'Failed to load recent projects' 
          });
        }
      },
      
      closeProject: () => {
        const { currentProject, unsavedChanges } = get();
        const hasUnsaved = Object.values(unsavedChanges).some(Boolean);
        const proceed = async () => {
          // Save current project state before closing
          if (currentProject) {
            get().saveProjectState().catch(console.error);
          }
          // Stop monitoring
          const monitor = ProjectStatusMonitor.getInstance();
          monitor.stopMonitoring();
          // Stop file watching
          fileWatcher.stopWatching();
          // Stop managing window title
          windowTitleManager.stopManaging();
          // Stop recovery monitoring
          recoveryService.stopRecoveryMonitoring();
          set({ 
            currentProject: null,
            openFiles: [],
            activeFile: null,
            unsavedChanges: {}
          });
        };

        if (hasUnsaved) {
          Promise.resolve().then(async () => {
            const count = Object.values(unsavedChanges).filter(Boolean).length;
            const ok = await tauriConfirm(`There are ${count} unsaved file(s). Close project and discard changes?`, { title: 'Unsaved changes', kind: 'warning' });
            if (!ok) return;
            await proceed();
          });
          return;
        }

        proceed();
      },
      
      addOpenFile: (filePath: string) => {
        set((state) => {
          if (!state.openFiles.includes(filePath)) {
            return { openFiles: [...state.openFiles, filePath] };
          }
          return state;
        });
      },
      
      removeOpenFile: (filePath: string) => {
        set((state) => {
          const openFiles = state.openFiles.filter(f => f !== filePath);
          const unsavedChanges = { ...state.unsavedChanges };
          delete unsavedChanges[filePath];
          
          // If we're closing the active file, set a new active file
          let activeFile = state.activeFile;
          if (activeFile === filePath) {
            activeFile = openFiles.length > 0 ? openFiles[0] : null;
          }
          
          // Close file in editor manager
          const editorManager = EditorManager.getInstance();
          editorManager.closeFile(filePath);
          
          return { openFiles, activeFile, unsavedChanges };
        });
      },
      
      setActiveFile: (filePath: string | null) => {
        set({ activeFile: filePath });
      },
      
      setUnsavedChanges: (filePath: string, hasChanges: boolean) => {
        set((state) => {
          const unsavedChanges = {
            ...state.unsavedChanges,
            [filePath]: hasChanges
          };
          
          // Enable/disable unsaved changes manager based on whether we have unsaved changes
          const hasAnyUnsaved = Object.values(unsavedChanges).some(Boolean);
          const manager = UnsavedChangesManager.getInstance();
          if (hasAnyUnsaved) {
            manager.enable();
          } else {
            manager.disable();
          }
          
          return { unsavedChanges };
        });
      },
      
      updateCursorPosition: (filePath: string, line: number, column: number) => {
        set((state) => {
          const cursorPositions = { ...state.cursorPositions };
          cursorPositions[filePath] = [line, column];
          return { cursorPositions };
        });
      },
      
      saveProjectState: async () => {
        const { currentProject, openFiles, activeFile, unsavedChanges, windowState } = get();
        if (!currentProject) return;
        
        try {
          // Filter out unsaved changes (we don't want to persist this)
          const cleanUnsavedChanges = { ...unsavedChanges };
          Object.keys(cleanUnsavedChanges).forEach(key => {
            if (!cleanUnsavedChanges[key]) {
              delete cleanUnsavedChanges[key];
            }
          });
          
          // Get editor states from editor manager and editor repository
          const editorManager = EditorManager.getInstance();
          const editorRepository = useEditorRepository.getState();
          const editorStates: Record<string, any> = {};
          
          for (const filePath of openFiles) {
            // Get state from editor manager (UI state)
            const managerState = editorManager.getEditorState(filePath);
            
            // Get state from editor repository (content, cursor, undo/redo)
            const repoState = editorRepository.getEditorState(filePath);
            
            // Combine both states
            editorStates[filePath] = {
              ...managerState,
              ...repoState
            };
          }
          
          const projectState: ProjectState = {
            version: "1.0.0",
            openFiles,
            activeFile,
            cursorPositions: editorRepository.cursorPositions,
            editorStates,
            windowState
          };
          
          // Save window state
          await windowService.saveWindowState();
          
          // Save recovery state first
          await recoveryService.saveRecoveryState(currentProject.id, projectState);
          
          // Then save the main project state
          await invoke('save_project_state', { 
            projectId: currentProject.id, 
            state: projectState
          });
          
          // Clear recovery state after successful save
          await recoveryService.clearRecoveryState(currentProject.id);
        } catch (error) {
          console.error('Failed to save project state:', error);
          // Don't clear recovery state if save failed
          throw error;
        }
      },
      
      loadProjectState: async (projectId: string) => {
        set({ loading: true, error: null });
        try {
          const state: ProjectState = await invoke('load_project_state', { projectId });
          set({ 
            openFiles: state.openFiles,
            activeFile: state.activeFile || null,
            windowState: state.windowState,
            loading: false
          });
          
          // Restore window state
          await windowService.restoreWindowState(state.windowState);
          
          // Load editor states into editor manager and editor repository
          const editorManager = EditorManager.getInstance();
          const editorRepository = useEditorRepository.getState();
          
          Object.entries(state.editorStates).forEach(([filePath, editorState]) => {
            // Load state into editor manager (UI state)
            editorManager.updateEditorState(filePath, editorState);
            
            // Load state into editor repository (content, cursor, undo/redo)
            if (editorState.cursorPosition) {
              editorRepository.updateEditorState(filePath, {
                cursorPosition: editorState.cursorPosition
              });
            }
          });
          
          // Load cursor positions
          if (state.cursorPositions) {
            Object.entries(state.cursorPositions).forEach(([filePath, position]) => {
              editorRepository.setCursorPosition(filePath, position[0], position[1]);
            });
          }
          
          // Handle version upgrades if needed
          if (state.version !== "1.0.0") {
            console.warn(`Project state version mismatch. Expected: 1.0.0, Actual: ${state.version}`);
            // In a real implementation, you would handle version upgrades here
          }
        } catch (error: any) {
          set({ 
            loading: false, 
            error: error.message || 'Failed to load project state' 
          });
        }
      },
      
      setWindowState: (state: WindowState) => {
        set({ windowState: state });
      },
      
      updateWindowState: async () => {
        try {
          const windowState = await windowService.getCurrentWindowState();
          set({ windowState });
        } catch (error) {
          console.error('Failed to update window state:', error);
        }
      },
      
      setLoading: (loading: boolean) => {
        set({ loading });
      },
      
      setError: (error: string | null) => {
        set({ error });
      },
    }),
    {
      name: 'project-storage',
      partialize: (state) => ({ 
        recentProjects: state.recentProjects,
        windowState: state.windowState
      }),
    }
  )
);

// Auto-save function with queue optimization
export function autoSaveProjectState(): void {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) {
    return;
  }

  // Serialize project state to JSON for saving
  const projectState = {
    version: "1.0.0",
    openFiles: useProjectStore.getState().openFiles,
    activeFile: useProjectStore.getState().activeFile,
    cursorPositions: useProjectStore.getState().cursorPositions,
    windowState: useProjectStore.getState().windowState,
    timestamp: Date.now()
  };

  const content = JSON.stringify(projectState, null, 2);
  const statePath = `${currentProject.path}/.toquemedia/project-state.json`;
  
  // Adiciona à queue para salvamento otimizado
  autoSaveQueue.addToQueue(statePath, content);
}

// Força o salvamento imediato de todos os arquivos pendentes
export async function flushAutoSave(): Promise<void> {
  await autoSaveQueue.flushAll();
}

// Força o salvamento de um arquivo específico
export async function flushAutoSaveFile(path: string): Promise<void> {
  await autoSaveQueue.flushFile(path);
}

// Retorna estatísticas da queue de auto-save
export function getAutoSaveStats(): {
  queueSize: number;
  isProcessing: boolean;
  oldestFile?: string;
  newestFile?: string;
} {
  return autoSaveQueue.getStats();
}
