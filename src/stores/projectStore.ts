import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProjectInfo, RecentProject, ProjectState, WindowState } from '../types/project';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { invoke } from '@/utils/invokeMetrics';
import { ProjectStatusMonitor } from '../utils/projectStatusMonitor';
import { ProjectFileWatcher } from '../utils/projectFileWatcher';
import { WindowTitleManager } from '../utils/windowTitleManager';
import { useEditorRepository } from './editorStore';
import { useLayoutStore } from './layoutStore';
import RecoveryService from '../services/recoveryService';
import WindowService from '../services/windowService';
import { sessionService } from '../services/agent/sessionService';
import CheckpointService from '../services/agent/checkpointService';
import { useChatStore } from './chatStore';
import { useProblemsStore } from './problemsStore';
import { IS_VITE_DEV } from '../utils/viteEnv';
import { devServerManager } from '../services/devServerManager';
import { logger } from '../utils/logger';
import { t } from '../i18n';

/**
 * Dedupe a recent-projects list by `path`. Rust's `get_recent_projects`
 * returns entries sorted by lastOpened DESC; the same project can appear
 * twice when the registry stores it with two different IDs (e.g. opened
 * once via CMD-mode auto-create and once via "Open folder"). Keeping the
 * FIRST occurrence preserves the most recent timestamp and matches what
 * the UI expects ("Recents" should be distinct projects, not entries).
 *
 * Until the Rust side dedupes at save-time, this is the frontend safety
 * net — UI consumers never have to worry about repeats.
 */
function dedupeRecentProjects(projects: RecentProject[]): RecentProject[] {
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const p of projects) {
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    out.push(p);
  }
  return out;
}

interface ProjectStore {
  currentProject: ProjectInfo | null;
  recentProjects: RecentProject[];
  windowState: WindowState;
  loading: boolean;
  error: string | null;
  cmdModeProjectPath: string | null;
  /** Paths that have been opened at least once in CMD mode — persisted. */
  cmdModeProjectPaths: string[];
  /**
   * Where the user was on the Welcome screen the last time the app quit.
   * Persisted so a restart returns them to the same sub-screen instead of
   * auto-opening the most recent project. `null` means "no explicit Welcome
   * state" (first launch, or the user has a project open) — the auto-open
   * logic in App.tsx may still reopen a recent project in that case.
   */
  welcomeScreen: 'hero' | 'settings' | null;
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
  setWelcomeScreen: (screen: 'hero' | 'settings' | null) => void;
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
      welcomeScreen: null,
      hasHydrated: false,

      setHasHydrated: (hydrated: boolean) => {
        set({ hasHydrated: hydrated });
      },

      setWelcomeScreen: (screen) => {
        set({ welcomeScreen: screen });
      },

      setCmdModeProjectPath: (path: string | null) => {
        if (path) {
          // Record that this path was opened in CMD mode (deduplicated, max 20)
          const existing = get().cmdModeProjectPaths.filter(p => p !== path)
          // Entering CMD mode clears the Welcome sub-screen marker — the
          // next app start should restore CMD, not Welcome.
          set({ cmdModeProjectPath: path, cmdModeProjectPaths: [path, ...existing].slice(0, 20), welcomeScreen: null })
        } else {
          // Leaving CMD back to Welcome — remember that's where the user is.
          set({ cmdModeProjectPath: null, welcomeScreen: 'hero' })
        }
      },

      removeCmdModePath: (path: string) => {
        set(state => ({
          cmdModeProjectPaths: state.cmdModeProjectPaths.filter(p => p !== path),
        }))
      },

      openProject: async (path: string, options?: { initGit?: boolean }) => {
        // Opening a project exits any Welcome state — clear the persisted marker.
        set({ loading: true, error: null, cmdModeProjectPath: null, welcomeScreen: null });

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
          // Avoid a redundant second IPC: Rust's `open_project` already wrote
          // the recents file, and we have all four fields RecentProject needs
          // in `projectInfo`. Constructing the entry locally + prepending +
          // deduping by path produces an identical sidebar result without the
          // extra `get_recent_projects` round-trip. The persisted file on disk
          // remains the source of truth and is re-read by `loadRecentProjects`
          // on mount, so eventual consistency is preserved across restarts.
          const freshEntry: RecentProject = {
            id: projectInfo.id,
            name: projectInfo.name,
            path: projectInfo.path,
            lastOpened: projectInfo.lastOpened,
          };
          // Most-recent-mode wins: opening in chat/IDE removes the path from the
          // CMD-mode list. Without this, a folder once opened in CMD stays
          // tagged as "Terminal" in WelcomeSidebar forever — even after it's
          // re-opened via "Open Folder" / "New Project" for chat use.
          set(state => ({
            currentProject: projectInfo,
            recentProjects: dedupeRecentProjects([freshEntry, ...state.recentProjects]),
            cmdModeProjectPaths: state.cmdModeProjectPaths.filter(p => p !== path),
            loading: false,
          }));

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

          // Hydrate the agent task tracker from disk. The tracker lives at
          // `<project>/.toquemedia/tasks.json` — committable so it travels
          // with the project, and the canonical source so a budget interrupt
          // / app restart / new chat session in the same project doesn't
          // make the agent re-infer progress from the filesystem (the
          // failure mode behind the 2026-05-19 batch-completion bug).
          try {
            const [{ loadTasksFromDisk }, { useAgentStore }] = await Promise.all([
              import('../services/agent/taskPersistence'),
              import('./agentStore'),
            ]);
            const tasks = await loadTasksFromDisk(path);
            useAgentStore.getState().setTasks(tasks);
          } catch (error) {
            // Tracker hydration is non-critical — fall back to an empty
            // tracker rather than block project open. The agent will seed
            // a fresh one on its next /plan or update_tasks call.
            logger.warn('project', 'Failed to hydrate task tracker:', error);
          }

          // Hydrate per-project permission grants. Trust is project-scoped:
          // if the user approved "all core tools" the last time they worked
          // on this project, that grant is restored on reopen. New projects
          // start with an empty set — the prompts re-fire and the user
          // re-approves explicitly. Failure path is fail-open (empty set =
          // re-prompt), which preserves the safety default.
          try {
            const [{ loadPermissionsFromDisk }, { hydrateApprovedScopes }] = await Promise.all([
              import('../services/agent/permissionPersistence'),
              import('./permissionStore'),
            ]);
            const scopes = await loadPermissionsFromDisk(path);
            hydrateApprovedScopes(scopes);
          } catch (error) {
            logger.warn('project', 'Failed to hydrate permission grants:', error);
          }

          // Hydrate per-project HTTP Client tabs + history. The Postman-like
          // panel is expected to remember what you were testing; without this
          // the user's request bodies, auth tokens, and 50-entry history
          // vanish on every reopen. Failure path leaves the default single
          // empty tab.
          try {
            const [{ loadHttpClientFromDisk }, { hydrateHttpClientFromDisk }] = await Promise.all([
              import('../services/httpClientPersistence'),
              import('./httpClientStore'),
            ]);
            const loaded = await loadHttpClientFromDisk(path);
            if (loaded) hydrateHttpClientFromDisk(loaded);
          } catch (error) {
            logger.warn('project', 'Failed to hydrate HTTP Client state:', error);
          }

          // Hydrate dirty editor buffers — restores unsaved edits from the
          // previous session. The editor itself already restored OPEN TABS
          // from localStorage (clean content read from disk); this step
          // overlays the unsaved content on top so a crash/reload between
          // edit-and-save isn't a silent data loss.
          try {
            const [{ loadEditorStateFromDisk }, { applyDirtyOverrides }] = await Promise.all([
              import('../services/editorStatePersistence'),
              import('./editorStore'),
            ]);
            const dirty = await loadEditorStateFromDisk(path);
            applyDirtyOverrides(dirty);
          } catch (error) {
            logger.warn('project', 'Failed to hydrate editor dirty buffers:', error);
          }

          // Hydrate the deploy state. The orchestration source of truth is
          // the worker; this restores the LAST IDE-visible view so a
          // reload mid-deploy doesn't blank the panel. Once the IDE
          // re-polls/streams from the worker, the record is updated.
          try {
            const [{ loadDeployStateFromDisk }, { hydrateDeployRecord }] = await Promise.all([
              import('../services/deployPersistence'),
              import('./deployStore'),
            ]);
            const record = await loadDeployStateFromDisk(path);
            if (record) hydrateDeployRecord(record);
          } catch (error) {
            logger.warn('project', 'Failed to hydrate deploy state:', error);
          }

          // Check for TMS.md — suggest /init only when (a) it's missing AND
          // (b) the project actually has content to analyze. Suggesting it on
          // a freshly-opened empty folder is noise: there is nothing to
          // memorize and the agent's first natural turn will start TMS.md
          // organically as work happens.
          try {
            await invoke('read_file', { path: `${path}/TMS.md` });
          } catch {
            // TMS.md missing — check if the project has any real content.
            // Look for top-level entries other than TM Code's own marker
            // (.toquemedia-id), git metadata (.git), and OS junk (.DS_Store).
            let projectHasContent = false;
            try {
              const entries = await invoke<string[]>('glob_files', {
                pattern: '*',
                directory: path,
              });
              const meaningful = entries.filter((entry) => {
                const name = entry.split('/').pop() ?? entry;
                return name !== '.toquemedia-id'
                  && name !== '.git'
                  && name !== '.DS_Store'
                  && name !== 'Thumbs.db';
              });
              projectHasContent = meaningful.length > 0;
            } catch {
              // glob_files failed — fail open (don't suggest) so we don't
              // nag on a transient FS hiccup.
              projectHasContent = false;
            }
            if (projectHasContent) {
              setTimeout(() => {
                const chatState = useChatStore.getState();
                if (chatState.activeSessionId) {
                  chatState.addSystemMessage(t('common.noTmsFile'));
                }
              }, 600);
            }
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
            recentProjects: dedupeRecentProjects(recentProjects),
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

          // Remove from persisted recent list so it doesn't reappear on
          // WelcomeScreen after restart. Logged on failure (was previously
          // .catch(()=>{}) which silently let the project come back).
          try {
            await invoke('remove_from_recent_projects', { projectId });
          } catch (err) {
            logger.warn('project', 'remove_from_recent_projects failed:', err);
          }

          // Async cleanup: delete every per-project artefact. Sessions
          // and checkpoints both live inside the project at
          // `<project>/.toquemedia/{sessions,checkpoints}/` (2026-05
          // migration — previously in `~/.toquemedia-studio/`). Deleting
          // the project directory itself would also wipe them, but the
          // explicit calls below ensure cleanup runs even when the
          // project folder removal fails or is partial.
          await sessionService.deleteAllProjectSessions(projectPath);
          await CheckpointService.getInstance().deleteAllProjectCheckpoints(projectPath);
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
        // User is now back on Welcome — remember that so a restart doesn't
        // auto-reopen the project they just closed.
        set({ welcomeScreen: 'hero' });
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
        welcomeScreen: state.welcomeScreen,
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
