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
import { t } from '@/i18n';


/**
 * Dedupe a recent-projects list by `path`. Rust's `get_recent_projects`
 * returns entries sorted by lastOpened DESC; the same project can appear
 * twice when the registry stores it with two different IDs (historically,
 * opened once via cwd-scoped auto-create and once via "Open folder"). Keeping the
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
  /**
   * Where the user was on the Welcome screen the last time the app quit.
   * Persisted so a restart returns them to the same sub-screen instead of
   * auto-opening the most recent project. `null` means "no explicit Welcome
   * state" (first launch, or the user has a project open) — the auto-open
   * logic in App.tsx may still reopen a recent project in that case.
   */
  welcomeScreen: 'hero' | 'settings' | null;
  hasHydrated: boolean;

  /**
   * True when the current project lacks TMS.md AND has meaningful content.
   * Set during openProject(); cleared after bootstrap creates TMS.md.
   * Used by usePromptBar to gate the TMS.md bootstrap flow.
   */
  noTmsFile: boolean;
  /** Transient guard — prevents re-entrant bootstrap while one is running. */
  tmsBootstrapping: boolean;

  // Actions
  openProject: (path: string, options?: { initGit?: boolean }) => Promise<void>;
  createProject: (path: string, template: string) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  closeProject: () => Promise<void>;
  /**
   * Forced, non-interactive teardown back to the Welcome screen — no
   * dirty-file prompt, no state save. Used when an admin blocks/deletes the
   * account in real time: the user must be expelled from the workspace
   * immediately, not asked whether to save.
   */
  expelToWelcome: () => void;
  removeFromRecent: (projectId: string) => Promise<void>;
  clearAllRecent: () => Promise<void>;
  deleteProject: (projectId: string, projectPath: string) => Promise<void>;
  saveProjectState: () => Promise<void>;
  loadProjectState: (projectId: string) => Promise<void>;
  setWindowState: (state: WindowState) => void;
  updateWindowState: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Mirror a just-opened project into the in-memory recents list (no IPC). */
  upsertRecentProject: (info: ProjectInfo) => void;
  setWelcomeScreen: (screen: 'hero' | 'settings' | null) => void;
  setHasHydrated: (hydrated: boolean) => void;
  setNoTmsFile: (value: boolean) => void;
  setTmsBootstrapping: (value: boolean) => void;
}

// File watcher instance
const fileWatcher = new ProjectFileWatcher();

// Lazy getters for services to avoid circular dependency / initialization order issues
const getRecoveryService = () => RecoveryService.getInstance();
const getWindowService = () => WindowService.getInstance();

/**
 * Switching/closing a project with the agent mid-task is destructive — the
 * run gets cancelled (see openProject/tearDownProject). Ask first, and point
 * the user at the non-destructive alternative ("Open in New Window", which
 * keeps both projects working in parallel). Returns true to proceed. When the
 * agent is idle there is nothing to lose, so no dialog.
 */
async function confirmCancelActiveRun(kind: 'switch' | 'close'): Promise<boolean> {
  let busy = false;
  try {
    // Dynamic imports: same circular-dep avoidance as tearDownProject
    // (projectStore → agentService → toolExecutor → projectStore).
    const agentService = (await import('../services/agent/agentService')).default.getInstance();
    busy = agentService.isAgentRunning();
    if (!busy) {
      const { useSubAgentStore } = await import('./subAgentStore');
      busy = useSubAgentStore.getState().getPendingCount() > 0;
    }
  } catch {
    busy = false;
  }
  if (!busy) return true;

  const name = useProjectStore.getState().currentProject?.name || '';
  const body = t(kind === 'switch' ? 'project.switchWhileRunning' : 'project.closeWhileRunning')
    .replace('{name}', name);
  return tauriConfirm(body, {
    title: t('project.agentBusyTitle'),
    kind: 'warning',
    okLabel: t('project.agentBusyConfirm'),
    cancelLabel: t('project.agentBusyStay'),
  });
}

/**
 * Cancels the in-flight agent work (main loop + sub-agents) for the CURRENT
 * project. Must run BEFORE `set_active_project` re-points the Rust clamp at
 * the next project — without this, the orphaned run kept burning tokens, its
 * pending diff approvals hung forever, and (worst) its next shell/PTY tool
 * calls were clamped to the NEW project's directory and executed there
 * (cross-project contamination). cancelLoop() already resolves diffs and
 * clears permission/credential/question prompts for every cancel path.
 */
async function cancelActiveRunForProjectExit(): Promise<void> {
  try {
    const [{ default: agentServiceModule }, { useSubAgentStore }] = await Promise.all([
      import('../services/agent/agentService'),
      import('./subAgentStore'),
    ]);
    useSubAgentStore.getState().abortAll();
    agentServiceModule.getInstance().cancelLoop();
  } catch (e) {
    logger.warn('project', 'Failed to cancel agent before project exit:', e);
  }
}

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

  // Sub-agents run outside the main loop's AbortController (own registry,
  // own controllers) — cancelLoop() alone left them alive after teardown,
  // still executing read tools against a project the UI already left.
  import('./subAgentStore').then(m => {
    m.useSubAgentStore.getState().abortAll();
  }).catch(() => {});

  // Shutdown MCP servers (dynamic import to avoid circular deps)
  import('../services/mcp/mcpService').then(m => {
    m.default.getInstance().shutdown().catch(() => {});
  });

  // Stop auto-save timer to prevent stale writes after session is cleared
  sessionService.stopAutoSave();

  // Stop project monitors/watchers
  ProjectStatusMonitor.getInstance().stopMonitoring();
  fileWatcher.stopWatching();
  WindowTitleManager.getInstance().stopManaging();
  getRecoveryService().stopRecoveryMonitoring();

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
      welcomeScreen: null,
      hasHydrated: false,
      noTmsFile: false,
      tmsBootstrapping: false,

      setHasHydrated: (hydrated: boolean) => {
        set({ hasHydrated: hydrated });
      },

      setWelcomeScreen: (screen) => {
        set({ welcomeScreen: screen });
      },

      setNoTmsFile: (value) => set({ noTmsFile: value }),
      setTmsBootstrapping: (value) => set({ tmsBootstrapping: value }),

      // Rust's open_project persists the recents FILE, but the Welcome
      // "Recents" list renders the in-memory array, which only re-reads disk
      // on mount. Callers that invoke open_project directly need this mirror,
      // otherwise the folder never appeared in Recents until an app restart
      // (user report, 2026-06-12). Same no-extra-IPC pattern as the
      // freshEntry construction inside openProject.
      upsertRecentProject: (info: ProjectInfo) => {
        const entry: RecentProject = {
          id: info.id,
          name: info.name,
          path: info.path,
          lastOpened: info.lastOpened,
        }
        set(state => ({
          recentProjects: dedupeRecentProjects([entry, ...state.recentProjects]),
        }))
      },

      openProject: async (path: string, options?: { initGit?: boolean }) => {
        // Clean up previous project's state before loading the new one
        const prevProject = get().currentProject;

        // Switching away from a project with the agent mid-task: confirm,
        // then cancel BEFORE anything re-points global state (Rust clamp,
        // dev server, chat wipe) at the new project. Same-path re-opens are
        // exempt — reloading the project you're in shouldn't kill its run.
        if (prevProject && prevProject.path !== path) {
          const proceed = await confirmCancelActiveRun('switch');
          if (!proceed) return;
          await cancelActiveRunForProjectExit();
        }

        // Opening a project exits any Welcome state — clear the persisted marker.
        set({ loading: true, error: null, welcomeScreen: null });

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
          try {
            await invoke('migrate_project_state', { projectPath: path });
          } catch (error) {
            logger.warn('project', 'Project state migration failed:', error);
          }
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
          set(state => ({
            currentProject: projectInfo,
            recentProjects: dedupeRecentProjects([freshEntry, ...state.recentProjects]),
            loading: false,
          }));

          // Clear editor open files and diagnostics when opening a new project
          try { useEditorRepository.getState().closeAllFiles() } catch (e) {
            logger.error('project', 'Failed to close editor files during project switch:', e)
          }
          useProblemsStore.getState().clear()

          // Check for recovery state before loading project state
          const hasRecovery = await getRecoveryService().hasRecoveryState(projectInfo.id);
          if (hasRecovery) {
            logger.warn('project', `Recovery state found for project ${projectInfo.id}. Consider recovering before loading.`);
          }

          // Start monitoring project status
          const monitor = ProjectStatusMonitor.getInstance();
          monitor.startMonitoring();

          // Start watching project files
          fileWatcher.startWatching(path);

          // Start managing window title
          WindowTitleManager.getInstance().startManaging();

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

          // Hydrate the agent task tracker from disk. The tracker lives in
          // app-managed per-project state, so a budget interrupt / app restart
          // / new chat session in the same project doesn't make the agent
          // re-infer progress from the filesystem (the failure mode behind
          // the 2026-05-19 batch-completion bug).
          try {
            const [{ loadTasksFromDisk }, { useAgentStore }] = await Promise.all([
              import('../services/agent/taskPersistence'),
              import('./agentStore'),
            ]);
            // Hydrate atomically — no clearTasks() before load. The old
            // project's tasks stay in the store during the async load, then
            // setTasks() atomically replaces them. This eliminates the race
            // window where the store is empty but tasks.json exists on disk
            // (which could cause the agent to re-seed a fresh tracker and
            // overwrite the real state). On load failure, clear stale data.
            const tasks = await loadTasksFromDisk(path);
            useAgentStore.getState().setTasks(tasks);
          } catch (error) {
            // Tracker hydration is non-critical — fall back to an empty
            // tracker rather than block project open. The agent will seed
            // a fresh one on its next /plan or update_tasks call.
            // Also clear stale cross-project data from the previous project.
            try {
              const { useAgentStore } = await import('./agentStore');
              useAgentStore.getState().clearTasks();
            } catch { /* non-critical */ }
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
            const perms = await loadPermissionsFromDisk(path);
            hydrateApprovedScopes(perms.scopes, path, perms.tools, perms.directories);
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

          // Check for TMS.md — suggest /init only when (a) it's missing AND
          // (b) the project actually has content to analyze. Suggesting it on
          // a freshly-opened empty folder is noise: there is nothing to
          // memorize. Missing TMS.md is optional context, so the next agent
          // turn should continue the user's task instead of forcing bootstrap.
          //
          // The "meaningful content" rule lives in projectHasContent.ts — it
          // rejects dot-files (.toquemedia/, .git/, .DS_Store, .gitignore,
          // .env, …) and tool artifacts (node_modules, dist, build, …)
          // because none of those alone represents developer-authored
          // intent worth analyzing. The Rust `glob_files('*')` returns
          // hidden entries by default (glob crate's `require_literal_leading_dot`
          // defaults to false), and the prior 4-name allowlist was leaking
          // `.toquemedia/` on every freshly-opened empty project.
          try {
            await invoke('read_file', { path: `${path}/TMS.md` });
            // TMS.md exists — ensure flag is cleared (covers re-open after bootstrap)
            set({ noTmsFile: false });
          } catch {
            // TMS.md not found — keep only state so the UI can suggest /init.
            // The agent preflight treats absence as optional context and lets
            // the user's next request proceed normally.
            const { projectHasMeaningfulContent } = await import('../utils/projectHasContent');
            let hasContent = false;
            try {
              const entries = await invoke<string[]>('glob_files', {
                pattern: '*',
                directory: path,
              });
              hasContent = projectHasMeaningfulContent(entries);
            } catch {
              hasContent = false;
            }
            set({ noTmsFile: hasContent });
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
          WindowTitleManager.getInstance().startManaging();

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

          // Async cleanup: delete app-managed artefacts before deleting the
          // project folder. The explicit calls below keep cleanup best-effort
          // even when the project folder removal fails or is partial.
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

        // Closing cancels the in-flight run (tearDownProject → cancelLoop);
        // give the user the chance to keep it working instead.
        const proceedBusy = await confirmCancelActiveRun('close');
        if (!proceedBusy) return;

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
        set({ welcomeScreen: 'hero', noTmsFile: false, tmsBootstrapping: false });
      },

      expelToWelcome: () => {
        // No prompt, no save — the account was suspended; get the user out of
        // any open project and onto the Welcome screen at once.
        tearDownProject();
        set({
          welcomeScreen: 'hero',
          noTmsFile: false,
          tmsBootstrapping: false,
        });
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
          await getWindowService().saveWindowState();

          // Save recovery state first
          await getRecoveryService().saveRecoveryState(currentProject.id, projectState);

          // Then save the main project state
          await invoke('save_project_state', {
            projectId: currentProject.id,
            state: projectState
          });

          // Clear recovery state after successful save
          await getRecoveryService().clearRecoveryState(currentProject.id);
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
          await getWindowService().restoreWindowState(state.windowState);

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
          const windowState = await getWindowService().getCurrentWindowState();
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
