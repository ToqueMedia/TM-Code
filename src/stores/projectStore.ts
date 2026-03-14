import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProjectInfo, RecentProject, ProjectState, WindowState } from '../types/project';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { ProjectStatusMonitor } from '../utils/projectStatusMonitor';
import { ProjectFileWatcher } from '../utils/projectFileWatcher';
import { WindowTitleManager } from '../utils/windowTitleManager';
import { useEditorRepository } from './editorStore';
import RecoveryService from '../services/recoveryService';
import WindowService from '../services/windowService';
import { logger } from '../utils/logger';

interface ProjectStore {
  currentProject: ProjectInfo | null;
  recentProjects: RecentProject[];
  windowState: WindowState;
  loading: boolean;
  error: string | null;

  // Actions
  openProject: (path: string) => Promise<void>;
  createProject: (path: string, template: string) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  closeProject: () => void;
  saveProjectState: () => Promise<void>;
  loadProjectState: (projectId: string) => Promise<void>;
  setWindowState: (state: WindowState) => void;
  updateWindowState: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

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
            logger.warn('project', `Recovery state found for project ${projectInfo.id}. Consider recovering before loading.`);
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
            logger.warn('project', 'Failed to load project state:', error);
          }
        } catch (error: unknown) {
          set({
            loading: false,
            error: (error as Error).message || 'Failed to open project'
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
        } catch (error: unknown) {
          set({
            loading: false,
            error: (error as Error).message || 'Failed to create project'
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
        } catch (error: unknown) {
          set({
            loading: false,
            error: (error as Error).message || 'Failed to load recent projects'
          });
        }
      },

      closeProject: () => {
        const { currentProject } = get();
        const editorState = useEditorRepository.getState();
        const hasDirtyFiles = editorState.openFiles.some(f => f.isDirty);

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
          // Close all editor files
          useEditorRepository.getState().closeAllFiles();
          set({ currentProject: null });
        };

        if (hasDirtyFiles) {
          Promise.resolve().then(async () => {
            const dirtyCount = editorState.openFiles.filter(f => f.isDirty).length;
            const ok = await tauriConfirm(`There are ${dirtyCount} unsaved file(s). Close project and discard changes?`, { title: 'Unsaved changes', kind: 'warning' });
            if (!ok) return;
            await proceed();
          });
          return;
        }

        proceed();
      },

      saveProjectState: async () => {
        const { currentProject, windowState } = get();
        if (!currentProject) return;

        try {
          // Read editor state (single source of truth)
          const editorState = useEditorRepository.getState();

          const projectState: ProjectState = {
            version: "1.0.0",
            openFiles: editorState.openFiles.map(f => f.path),
            activeFile: editorState.activeFile,
            cursorPositions: editorState.cursorPositions,
            editorStates: {},
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
          logger.error('project', 'Failed to save project state:', error);
          throw error;
        }
      },

      loadProjectState: async (projectId: string) => {
        set({ loading: true, error: null });
        try {
          const state: ProjectState = await invoke('load_project_state', { projectId });
          set({
            windowState: state.windowState,
            loading: false
          });

          // Restore window state
          await windowService.restoreWindowState(state.windowState);

          // Restore editor state: open files and set active
          const editorRepo = useEditorRepository.getState();
          for (const filePath of state.openFiles) {
            try {
              await editorRepo.openFile(filePath);
            } catch (err) {
              logger.warn('project', `Failed to reopen file ${filePath}:`, err);
            }
          }
          if (state.activeFile) {
            editorRepo.setActiveFile(state.activeFile);
          }

          // Restore cursor positions
          if (state.cursorPositions) {
            Object.entries(state.cursorPositions).forEach(([filePath, position]) => {
              editorRepo.setCursorPosition(filePath, position[0], position[1]);
            });
          }
        } catch (error: unknown) {
          set({
            loading: false,
            error: (error as Error).message || 'Failed to load project state'
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
          logger.error('project', 'Failed to update window state:', error);
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

// Auto-save function — reads from editorStore (single source of truth)
export function autoSaveProjectState(): void {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  useProjectStore.getState().saveProjectState().catch(console.error);
}
