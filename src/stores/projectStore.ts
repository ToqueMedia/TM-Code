import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProjectInfo, RecentProject, ProjectState, WindowState } from '../types/project';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { ProjectStatusMonitor } from '../utils/projectStatusMonitor';
import { ProjectFileWatcher } from '../utils/projectFileWatcher';
import { WindowTitleManager } from '../utils/windowTitleManager';
import { useEditorRepository } from './editorStore';
import { useLayoutStore } from './layoutStore';
import RecoveryService from '../services/recoveryService';
import WindowService from '../services/windowService';
import { sessionService } from '../services/agent/sessionService';
import { useChatStore } from './chatStore';
import { useProblemsStore } from './problemsStore';
import { IS_VITE_DEV } from '../utils/viteEnv';
import { devServerManager } from '../services/devServerManager';
import { logger } from '../utils/logger';
import { t } from '../i18n';

interface ProjectStore {
  currentProject: ProjectInfo | null;
  recentProjects: RecentProject[];
  windowState: WindowState;
  loading: boolean;
  error: string | null;
  cmdModeProjectPath: string | null;
  /** Paths that have been opened at least once in CMD mode — persisted. */
  cmdModeProjectPaths: string[];
  hasHydrated: boolean;

  // Actions
  openProject: (path: string, options?: { initGit?: boolean }) => Promise<void>;
  createProject: (path: string, template: string) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  closeProject: () => Promise<void>;
  removeFromRecent: (projectId: string) => Promise<void>;
  clearAllRecent: () => Promise<void>;
  deleteProject: (projectId: string, projectPath: string) => Promise<void>;
  saveProjectState: () => Promise<void>;
  loadProjectState: (projectId: string) => Promise<void>;
  setWindowState: (state: WindowState) => void;
  updateWindowState: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCmdModeProjectPath: (path: string | null) => void;
  /** Remove a path from the CMD mode paths list (e.g. user promotes it to an IDE project). */
  removeCmdModePath: (path: string) => void;
  setHasHydrated: (hydrated: boolean) => void;
}

// File watcher instance
const fileWatcher = new ProjectFileWatcher();

// Window title manager instance
const windowTitleManager = WindowTitleManager.getInstance();

// Recovery service instance
const recoveryService = RecoveryService.getInstance();

// Window service instance
const windowService = WindowService.getInstance();

/**
 * Tears down the current project: cancels agent, stops all monitors/watchers,
 * closes editor files, stops dev server, clears preview, and resets state.
 * No confirmation dialog. No state save. Use for forced teardowns
 * (e.g. before deleting a project).
 */
function tearDownProject() {
  // Cancel any running agent loop
  // (dynamic import to avoid circular dep: projectStore → agentService → toolExecutor → projectStore)
  import('../services/agent/agentService').then(m => {
    m.default.getInstance().cancelLoop();
  });

  // Shutdown MCP servers (dynamic import to avoid circular deps)
  import('../services/mcp/mcpService').then(m => {
    m.default.getInstance().shutdown().catch(() => {});
  });

  // Stop auto-save timer to prevent stale writes after session is cleared
  sessionService.stopAutoSave();

  // Stop project monitors/watchers
  ProjectStatusMonitor.getInstance().stopMonitoring();
  fileWatcher.stopWatching();
  windowTitleManager.stopManaging();
  recoveryService.stopRecoveryMonitoring();

  // Close editor files
  useEditorRepository.getState().closeAllFiles();

  // Clear all chat sessions and streaming state
  useChatStore.getState().clearAllSessions();

  // Clear file tree to free memory (will reload for next project)
  import('./fileTreeStore').then(m => {
    m.useFileTreeRepository.setState({ root: null, searchResults: [], error: null });
  }).catch(() => {});

  // Dispose all Monaco models for closed files
  try {
    const monaco = (window as unknown as Record<string, unknown>).monaco as { editor?: { getModels?: () => { dispose: () => void }[] } } | undefined;
    monaco?.editor?.getModels?.().forEach(m => m.dispose());
  } catch {}

  // Stop dev server and clear preview state
  devServerManager.stop().catch(() => {});
  const layout = useLayoutStore.getState();
  layout.clearDevServer();
  if (layout.viewMode === 'preview' || layout.viewMode === 'generating') {
    layout.setViewMode('chat');
  }

  // Release app-level project isolation
  invoke('clear_active_project', { projectId: useProjectStore.getState().currentProject?.id || '' }).catch(() => {});

  // Clear current project
  useProjectStore.setState({ currentProject: null });
}

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
      cmdModeProjectPath: null,
      cmdModeProjectPaths: [],
      hasHydrated: false,

      setHasHydrated: (hydrated: boolean) => {
        set({ hasHydrated: hydrated });
      },

      setCmdModeProjectPath: (path: string | null) => {
        if (path) {
          // Record that this path was opened in CMD mode (deduplicated, max 20)
          const existing = get().cmdModeProjectPaths.filter(p => p !== path)
          set({ cmdModeProjectPath: path, cmdModeProjectPaths: [path, ...existing].slice(0, 20) })
        } else {
          set({ cmdModeProjectPath: null })
        }
      },

      removeCmdModePath: (path: string) => {
        set(state => ({
          cmdModeProjectPaths: state.cmdModeProjectPaths.filter(p => p !== path),
        }))
      },

      openProject: async (path: string, options?: { initGit?: boolean }) => {
        set({ loading: true, error: null, cmdModeProjectPath: null });

        // Clean up previous project's state before loading the new one
        const prevProject = get().currentProject;
        if (prevProject) {
          // Stop old dev server and clear preview — await to ensure port is freed
          try {
            await devServerManager.stop();
          } catch (e) {
            logger.warn('project', 'Failed to stop dev server during project switch:', e);
          }
          const layout = useLayoutStore.getState();
          layout.clearDevServer();
          layout.clearDevServerLogs();
          layout.setScaffoldPhase(null);
          // Reset HTTP Client for the new project context
          const { useHttpClientStore } = await import('./httpClientStore');
          useHttpClientStore.getState().resetForNewProject();
          if (layout.viewMode === 'preview' || layout.viewMode === 'generating') {
            layout.setViewMode('chat');
          }
        }

        try {
          const projectInfo: ProjectInfo = await invoke('open_project', { path, initGit: options?.initGit });
          // Reload recent projects so sidebar updates in real-time
          const recentProjects = await invoke<RecentProject[]>('get_recent_projects').catch(() => get().recentProjects);
          set({
            currentProject: projectInfo,
            recentProjects,
            loading: false
          });

          // Clear editor open files and diagnostics when opening a new project
          try { useEditorRepository.getState().closeAllFiles() } catch (e) {
            logger.error('project', 'Failed to close editor files during project switch:', e)
          }
          useProblemsStore.getState().clear()

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

          // Activate app-level isolation for this project
          try {
            await invoke('set_active_project', { projectId: projectInfo.id, projectPath: path });
          } catch (err) {
            logger.warn('project', 'Failed to activate project isolation:', err);
          }

          // Load project state if exists
          try {
            await get().loadProjectState(projectInfo.id);
          } catch (error) {
            logger.warn('project', 'Failed to load project state:', error);
          }

          // Check for TMS.md — suggest /init if missing so the agent has project context
          try {
            await invoke('read_file', { path: `${path}/TMS.md` });
          } catch {
            // TMS.md doesn't exist — suggest initialization after a brief delay
            // so the chat session is ready
            setTimeout(() => {
              const chatState = useChatStore.getState();
              if (chatState.activeSessionId) {
                chatState.addSystemMessage(t('common.noTmsFile'));
              }
            }, 600);
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

          // Activate app-level isolation for this project
          invoke('set_active_project', { projectId: projectInfo.id, projectPath: path }).catch(err => {
            logger.warn('project', 'Failed to activate project isolation:', err);
          });
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

      clearAllRecent: async () => {
        try {
          const count = get().recentProjects.length;
          if (count === 0) return;

          const ok = await tauriConfirm(
            `Limpar a lista de projectos recentes (${count})?\n\nOs ficheiros dos projectos não são apagados — apenas desaparecem desta lista.`,
            { title: 'Limpar recentes', kind: 'warning' }
          );
          if (!ok) return;

          await invoke('clear_recent_projects');
          set({ recentProjects: [] });
        } catch (error) {
          logger.error('project', 'Failed to clear recent projects:', error);
          throw error;
        }
      },

      removeFromRecent: async (projectId: string) => {
        try {
          const project = get().recentProjects.find(p => p.id === projectId);
          const name = project?.name || projectId;

          const ok = await tauriConfirm(
            `Remover "${name}" da lista de projectos recentes?`,
            { title: 'Remover projecto', kind: 'warning' }
          );
          if (!ok) return;

          // If removing the current project, close it first
          const { currentProject } = get();
          if (currentProject?.id === projectId) {
            await get().closeProject();
            // User cancelled the close dialog — abort
            if (get().currentProject?.id === projectId) return;
          }
          await invoke('remove_from_recent_projects', { projectId });
          set(state => ({
            recentProjects: state.recentProjects.filter(p => p.id !== projectId),
          }));
        } catch (error) {
          logger.error('project', 'Failed to remove project from recent:', error);
          throw error;
        }
      },

      deleteProject: async (projectId: string, projectPath: string) => {
        try {
          const project = get().recentProjects.find(p => p.id === projectId);
          const name = project?.name || projectPath.replace(/\\/g, '/').split('/').pop() || projectId;

          const ok = await tauriConfirm(
            `Eliminar permanentemente "${name}" e todos os seus ficheiros?\n\nEsta acção não pode ser revertida.`,
            { title: 'Eliminar projecto', kind: 'warning' }
          );
          if (!ok) return;

          const { currentProject } = get();
          const isCurrentProject = currentProject?.id === projectId;

          if (isCurrentProject) {
            // tearDownProject cancels agent, stops dev server, clears preview,
            // clears sessions, and sets currentProject to null
            tearDownProject();
          } else if (devServerManager.getProjectPath() === projectPath) {
            // Stop the dev server only if it belongs to the project being deleted
            await devServerManager.stop().catch(() => {});
            useLayoutStore.getState().clearDevServer();
          }

          // Remove from recentProjects IMMEDIATELY so App.tsx auto-open
          // doesn't try to re-open the deleted project
          set(state => ({
            recentProjects: state.recentProjects.filter(p => p.id !== projectId),
          }));

          // Remove from persisted recent list so it doesn't reappear on WelcomeScreen
          await invoke('remove_from_recent_projects', { projectId }).catch(() => {});

          // Async cleanup: delete sessions and project files from disk
          await sessionService.deleteAllProjectSessions(projectPath);
          await invoke('delete_project', { projectId, projectPath });
        } catch (error) {
          logger.error('project', 'Failed to delete project:', error);
          throw error;
        }
      },

      closeProject: async () => {
        const { currentProject } = get();
        const editorState = useEditorRepository.getState();
        const hasDirtyFiles = editorState.openFiles.some(f => f.isDirty);

        if (hasDirtyFiles) {
          const dirtyCount = editorState.openFiles.filter(f => f.isDirty).length;
          const ok = await tauriConfirm(`There are ${dirtyCount} unsaved file(s). Close project and discard changes?`, { title: 'Unsaved changes', kind: 'warning' });
          if (!ok) return;
        }

        // Save current project state before closing
        if (currentProject) {
          await get().saveProjectState().catch(console.error);
        }
        tearDownProject();
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
        windowState: state.windowState,
        cmdModeProjectPath: state.cmdModeProjectPath,
        cmdModeProjectPaths: state.cmdModeProjectPaths,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      }
    }
  )
);

// ── DEBUG: log currentProject transitions ─────────────────────────────────
if (IS_VITE_DEV) {
  useProjectStore.subscribe((state, prev) => {
    if (state.currentProject !== prev.currentProject) {
      console.log(
        `%c[projectStore] currentProject changed`,
        'color:#2ea043;font-weight:bold',
        prev.currentProject?.name ?? null, '→', state.currentProject?.name ?? null,
        `(loading=${state.loading})`,
      );
    }
  });
}
// ──────────────────────────────────────────────────────────────────────────

// Auto-save function — reads from editorStore (single source of truth)
export function autoSaveProjectState(): void {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  useProjectStore.getState().saveProjectState().catch(console.error);
}
