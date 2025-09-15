import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProjectInfo, RecentProject, ProjectState, WindowState } from '../types/project';
import { invoke } from '@tauri-apps/api/core';
import { UnsavedChangesManager } from '../utils/unsavedChangesManager';
import { EditorManager } from '../utils/editorManager';

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
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

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
        // Save current project state before closing
        const { currentProject } = get();
        if (currentProject) {
          get().saveProjectState().catch(console.error);
        }
        
        set({ 
          currentProject: null,
          openFiles: [],
          activeFile: null,
          unsavedChanges: {}
        });
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
          
          // Get editor states from editor manager
          const editorManager = EditorManager.getInstance();
          const editorStates: Record<string, any> = {};
          for (const filePath of openFiles) {
            const editorState = editorManager.getEditorState(filePath);
            if (editorState) {
              editorStates[filePath] = editorState;
            }
          }
          
          const state: ProjectState = {
            openFiles,
            activeFile,
            cursorPositions: {}, // We would populate this with actual cursor positions
            editorStates,
            windowState
          };
          
          await invoke('save_project_state', { 
            projectId: currentProject.id, 
            state 
          });
        } catch (error) {
          console.error('Failed to save project state:', error);
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
          
          // Load editor states into editor manager
          const editorManager = EditorManager.getInstance();
          Object.entries(state.editorStates).forEach(([filePath, editorState]) => {
            editorManager.updateEditorState(filePath, editorState);
          });
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