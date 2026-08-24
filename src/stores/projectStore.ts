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
import { useTerminalPanelStore } from './terminalPanelStore';
import { IS_VITE_DEV } from '../utils/viteEnv';
import { devServerManager } from '../services/devServerManager';
import { logger } from '../utils/logger';
import { t } from '@/i18n';


/**
 * Dedupe the workspace project list by `path`. The same folder can appear
 * twice when the registry stored two IDs (cwd auto-create vs "Open folder").
 * Keeps the first occurrence to preserve STABLE order — the sidebar is a
 * workspace list, not a recents ranking (opening a project must not bubble
 * it to the top).
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

/**
 * Insert or update a project in the workspace list without reordering.
 * Existing entries stay at their index; new ones are appended.
 */
function upsertProjectStable(list: RecentProject[], entry: RecentProject): RecentProject[] {
  const idx = list.findIndex(p => p.path === entry.path || p.id === entry.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...next[idx], ...entry, path: entry.path, id: entry.id };
    return dedupeRecentProjects(next);
  }
  return dedupeRecentProjects([...list, entry]);
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
  /**
   * Close to Welcome. Can DECLINE (returns false) when the user answers
   * "keep working" to the busy/dirty confirms — callers that continue with
   * side effects (sign-out!) must check the result. `force` skips both
   * confirms for non-interactive paths (project directory deleted).
   */
  closeProject: (options?: { force?: boolean }) => Promise<boolean>;
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
 * Closing a project with the agent mid-task is still destructive (the
 * window is leaving that project for good). Switching is NOT — F2 parks the
 * run as a background project-run (runProjectContext + preserved session),
 * so no confirm / no cancel on switch. Returns true to proceed.
 */
async function confirmCancelActiveRun(kind: 'switch' | 'close'): Promise<boolean> {
  // F2 MDI: switching projects keeps the agent running on the previous
  // project — there is nothing destructive to confirm.
  if (kind === 'switch') return true;

  // Close → Welcome kills ALL in-window runs (including parked ones on other
  // projects). Warn if anything is busy in this process.
  let busy = false;
  try {
    const agentService = (await import('../services/agent/agentService')).default.getInstance();
    busy = agentService.isAgentRunning();
    if (!busy) {
      const { useSubAgentStore } = await import('./subAgentStore');
      busy = useSubAgentStore.getState().getPendingCount() > 0;
    }
    if (!busy) {
      const { useParallelTaskStore } = await import('./parallelTaskStore');
      for (const r of useParallelTaskStore.getState().runs.values()) {
        if (r.status === 'running' || r.status === 'queued') {
          busy = true;
          break;
        }
      }
    }
  } catch {
    busy = false;
  }
  if (!busy) return true;

  const name = useProjectStore.getState().currentProject?.name || '';
  const body = t('project.closeWhileRunning').replace('{name}', name);
  return tauriConfirm(body, {
    title: t('project.agentBusyTitle'),
    kind: 'warning',
    okLabel: t('project.agentBusyConfirm'),
    cancelLabel: t('project.agentBusyStay'),
  });
}

/**
 * Tears down the open project and returns to a no-project state (Welcome).
 * F2 distinction:
 *   - **Switch** A→B: parks runs (no tearDown).
 *   - **Close / expel**: leaves the window with NO focused project, so every
 *     in-window run (including parked ones on other projects) must die —
 *     there is no UI surface left to host them.
 * No confirmation dialog. No state save.
 */
function tearDownProject(_opts?: { forceCancelAll?: boolean }) {
  // Capture before clearing state — MCP scope stop needs the path.
  const closingPath = useProjectStore.getState().currentProject?.path;

  // Always kill every agent in this window: close/expel have no multi-project
  // host. (Switch never calls tearDown.) Sync cancel before wiping sessions
  // so pending diffs/permissions resolve while the session Map still exists.
  void (async () => {
    try {
      const [{ default: agentServiceModule }, { useSubAgentStore }, { useParallelTaskStore }] =
        await Promise.all([
          import('../services/agent/agentService'),
          import('./subAgentStore'),
          import('./parallelTaskStore'),
        ]);
      useSubAgentStore.getState().abortAll();
      useParallelTaskStore.getState().abortAll();
      agentServiceModule.getInstance().cancelLoop();
    } catch (e) {
      logger.warn('project', 'Failed to cancel agent during tearDown:', e);
    }
  })();

  // Close/expel: leave window with no project — stop ALL MCP scopes and
  // every dev-server slot. Switch never calls tearDown.
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

  // Kill user PTYs — they were spawned in the project that is going away.
  void import('./terminalPanelStore').then(m => {
    m.useTerminalPanelStore.getState().closeAll()
  }).catch(() => {})

  // Clear all chat sessions and streaming state (full wipe — no park on close)
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

  // F5: stop EVERY project slot (close leaves no host for background servers)
  void devServerManager.stopAll().catch(() => {});
  const layout = useLayoutStore.getState();
  layout.clearDevServer();
  layout.restoreParkSnapshot(null);
  if (layout.viewMode === 'preview' || layout.viewMode === 'generating') {
    layout.setViewMode('chat');
  }
  if (closingPath) {
    void import('../services/projectWorkspacePark')
      .then((m) => { m.clearProjectParks(closingPath) })
      .catch(() => {})
  }

  // Release app-level project isolation. F2 MDI: close/expel leaves NO focused
  // project and has already aborted every in-window run, so clear the WHOLE
  // registry — not just the focused project (switching keeps the others
  // registered; only close/expel empties it, else stale entries accumulate).
  invoke('clear_all_active_projects').catch(() => {});

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

      // Mirror disk workspace list into memory without reordering. Callers
      // that invoke open_project directly need this so a new folder appears
      // in the sidebar without an app restart (2026-06-12).
      upsertRecentProject: (info: ProjectInfo) => {
        const entry: RecentProject = {
          id: info.id,
          name: info.name,
          path: info.path,
          lastOpened: info.lastOpened,
        }
        set(state => ({
          recentProjects: upsertProjectStable(state.recentProjects, entry),
        }))
      },

      openProject: async (path: string, options?: { initGit?: boolean }) => {
        // Re-selecting the project you ALREADY have open is a no-op. Without this,
        // clicking the active project in the recents list / titlebar re-ran the
        // whole open flow — stopping its dev server, clearing the preview + logs,
        // resetting the HTTP client and bouncing the view back to chat — i.e. a
        // pointless "reload" of the project you're already in. An explicit initGit
        // refresh is exempt (the user asked for a git action on this path).
        // Normalize slashes/trailing slash: multi-agent/recents paths can differ
        // slightly from currentProject.path and used to re-trigger a full open.
        const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
        if (
          get().currentProject?.path
          && normPath(get().currentProject!.path) === normPath(path)
          && !options?.initGit
        ) return;

        // Clean up previous project's state before loading the new one
        const prevProject = get().currentProject;

        // F2 MDI: switching projects does NOT cancel the in-flight agent.
        // The main run is bound to its project via toolExecutor.setProjectContext
        // (agentRunner); chatStore keeps the streaming session in memory; the
        // parallel runner uses run.projectPath. set_active_project ADDS the
        // new project to the Rust registry without dropping the previous one,
        // so shell/PTY of a background run stays clamped to the right tree.

        // ── Kick the slow work off IN PARALLEL ─────────────────────────────
        // Switching used to serialize THREE awaits before the UI followed
        // (double-open guard IPC → park → open_project IPC), which is the
        // "pequenos atrasos até à troca efectivar" feel. open_project's side
        // effects when the guard later declines are benign (workspace-list
        // write for a project that is already in the list), so start it now
        // and only gate the final `set({currentProject})` on the guard.
        const openProjectInfoPromise: Promise<ProjectInfo> = invoke('open_project', {
          path,
          initGit: options?.initGit,
        });
        // Early guard returns below leave this promise unawaited — mark the
        // rejection handled so a failed open can't surface as unhandled.
        void openProjectInfoPromise.catch(() => undefined);

        // Double-open guard (cross-window): the same project in two windows
        // shares the state dir (sessions last-write-wins) AND the working
        // tree (two agents writing). Default = warn + optional Open anyway.
        // Settings → hardBlockSecondProjectWindow refuses without override
        // (staleness still frees dead owners — no permanent strand).
        if (prevProject?.path !== path) {
          try {
            const { isProjectOpenElsewhere } = await import('../services/projectWindowLockService');
            // Runner headless (evals P6): um runner SIGKILLado deixa um lock
            // fresco (<90s de staleness) e o aviso de double-open é um
            // diálogo que ninguém responde numa janela oculta — o projecto
            // nunca abria ("project did not open within 60s"). Em modo
            // runner o guard é saltado: a única "outra janela" plausível é o
            // cadáver da corrida anterior. (Residual do design doc:
            // identidade própria do runner no bus de disco.)
            let runnerMode = false;
            try {
              const { invoke } = await import('@/utils/invokeMetrics');
              runnerMode = !!(await invoke('runner_get_job'));
            } catch { /* fora do Tauri: não é runner */ }
            const openElsewhere = runnerMode ? false : await isProjectOpenElsewhere(path);
            const { useSettingsStore } = await import('./settingsStore');
            const { doubleOpenDecision } = await import('../services/doubleOpenGuard');
            const decision = doubleOpenDecision(
              useSettingsStore.getState().hardBlockSecondProjectWindow,
              openElsewhere,
            );
            if (decision !== 'allow') {
              const name = path.replace(/\\/g, '/').split('/').pop() || path;
              if (decision === 'hard_block') {
                set({
                  error: t('project.alreadyOpenElsewhereHard').replace('{name}', name),
                  loading: false,
                });
                return;
              }
              const ok = await tauriConfirm(
                t('project.alreadyOpenElsewhere').replace('{name}', name),
                {
                  title: t('project.alreadyOpenElsewhereTitle'),
                  kind: 'warning',
                  okLabel: t('project.alreadyOpenElsewhereOk'),
                },
              );
              if (!ok) return;
            }
          } catch { /* best-effort */ }
        }

        // In-window multi-project switch (F2): keep workspace mounted; skip
        // cold-open work that moves the window / reopens every editor tab.
        // `loading: true` on switch made the chrome feel laggy while a
        // background agent kept running on the previous project.
        const isInWindowSwitch = !!(prevProject && prevProject.path !== path);
        if (isInWindowSwitch) {
          set({ error: null, welcomeScreen: null });
        } else {
          set({ loading: true, error: null, welcomeScreen: null });
        }

        if (prevProject && prevProject.path !== path) {
          // F5 "tudo vivo": park the outgoing project's UI + leave its dev
          // server process running (multi-slot). Do NOT stop/clear.
          try {
            const { parkLayout, parkHttpClient } = await import('../services/projectWorkspacePark');
            const layout = useLayoutStore.getState();
            parkLayout(prevProject.path, layout.captureParkSnapshot());
            const { useHttpClientStore } = await import('./httpClientStore');
            const http = useHttpClientStore.getState();
            parkHttpClient(prevProject.path, {
              tabs: http.tabs,
              activeTabId: http.activeTabId,
              history: http.history,
              isHistoryOpen: http.isHistoryOpen,
            });
          } catch (e) {
            logger.warn('project', 'Failed to park workspace on switch:', e);
          }
        }

        try {
          const projectInfo: ProjectInfo = await openProjectInfoPromise;
          // Migration is rare after first open — never block the switch path.
          if (isInWindowSwitch) {
            void invoke('migrate_project_state', { projectPath: path }).catch((error) => {
              logger.warn('project', 'Project state migration failed:', error);
            });
          } else {
            try {
              await invoke('migrate_project_state', { projectPath: path });
            } catch (error) {
              logger.warn('project', 'Project state migration failed:', error);
            }
          }
          // Avoid a redundant second IPC: Rust's `open_project` already wrote
          // the workspace list file. Mirror in-memory without bubbling the
          // selected project to the top (stable workspace order).
          const freshEntry: RecentProject = {
            id: projectInfo.id,
            name: projectInfo.name,
            path: projectInfo.path,
            lastOpened: projectInfo.lastOpened,
          };
          // Set focus ASAP so chat restore / UI can follow without waiting on
          // permissions, TMS probes, or window-state IPC.
          set(state => ({
            currentProject: projectInfo,
            recentProjects: upsertProjectStable(state.recentProjects, freshEntry),
            loading: false,
          }));
          // Clear editor open files and diagnostics when opening a new project
          try { useEditorRepository.getState().closeAllFiles() } catch (e) {
            logger.error('project', 'Failed to close editor files during project switch:', e)
          }
          try { useTerminalPanelStore.getState().closeAll() } catch (e) {
            logger.error('project', 'Failed to close terminals during project switch:', e)
          }
          useProblemsStore.getState().clear()

          // Cold open only — recovery probe is non-critical noise on switch.
          if (!isInWindowSwitch) {
            try {
              const hasRecovery = await getRecoveryService().hasRecoveryState(projectInfo.id);
              if (hasRecovery) {
                logger.warn('project', `Recovery state found for project ${projectInfo.id}. Consider recovering before loading.`);
              }
            } catch { /* non-critical */ }
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

          // loadProjectState restores window geometry + every open editor tab
          // from disk. That is correct for a cold open, but on in-window
          // switch it REPOSITIONS the OS window and re-opens files we just
          // closed — the main source of "heavy" multi-project switching.
          // Layout/preview come from park; editor tabs from localStorage.
          if (!isInWindowSwitch) {
            try {
              await get().loadProjectState(projectInfo.id);
            } catch (error) {
              logger.warn('project', 'Failed to load project state:', error);
            }
          }

          // Hydrate the agent task tracker from disk. The tracker lives in
          // app-managed per-project state, so a budget interrupt / app restart
          // / new chat session in the same project doesn't make the agent
          // re-infer progress from the filesystem (the failure mode behind
          // the 2026-05-19 batch-completion bug).
          try {
            // TRACKER POR-SESSÃO (sem-deus): o tracker é por-sessão, não mais
            // por-projeto. O sync do foco garante a invariante "o painel mostra
            // o tracker da sessão ativa"; arranca-o (idempotente) e reconcilia
            // já a sessão ativa deste projeto (foca + hidrata tasks-<sid>.json).
            const { startTrackerFocusSync, reconcileTrackerFocus } = await import(
              '../services/agent/trackerFocusSync'
            );
            startTrackerFocusSync();
            const { useChatStore } = await import('./chatStore');
            await reconcileTrackerFocus(useChatStore.getState().activeSessionId);
          } catch (error) {
            // Hidratação não-crítica — a sessão começa com tracker vazio; o
            // agente re-semeia no próximo /plan ou update_tasks.
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
            // projectId is required for multi-project: hydrate stores under
            // byProject[id] without wiping other open projects' grants.
            hydrateApprovedScopes(perms.scopes, path, perms.tools, perms.directories, perms.autoMode, perms.commandPrefixes, projectInfo.id);
          } catch (error) {
            logger.warn('project', 'Failed to hydrate permission grants:', error);
          }

          // F5: restore parked workspace (layout + HTTP) if this project was
          // left open in-window; else hydrate from disk / defaults.
          try {
            const { takeLayoutPark, takeHttpPark } = await import('../services/projectWorkspacePark');
            const layoutSnap = takeLayoutPark(path);
            useLayoutStore.getState().restoreParkSnapshot(layoutSnap);
            // Point multi-slot manager at this project (keeps process if live).
            devServerManager.setFocusedProject(path);
            // If this project has no live preview URL, drop any ghost macOS
            // webview still bound to the previous project's localhost port.
            // Otherwise it keeps retrying and floods [runtime] Network errors
            // into the newly focused layoutStore / DevServerStatus.
            {
              const layout = useLayoutStore.getState();
              const hasPreviewTarget = !!(
                layout.devServer?.frontendUrl
                || layout.devServer?.backendUrl
                || (layout.previewMode === 'static' && layout.previewHtmlContent)
              );
              if (!hasPreviewTarget) {
                void import('../components/ui/TauriWebview')
                  .then((m) => { m.closePreviewWebview() })
                  .catch(() => {});
              }
            }

            const httpSnap = takeHttpPark(path);
            const { useHttpClientStore, hydrateHttpClientFromDisk } = await import('./httpClientStore');
            if (httpSnap) {
              useHttpClientStore.setState({
                tabs: httpSnap.tabs as never,
                activeTabId: httpSnap.activeTabId,
                history: httpSnap.history as never,
                isHistoryOpen: httpSnap.isHistoryOpen,
              });
            } else {
              // Cold open — load from disk or empty default.
              useHttpClientStore.getState().resetForNewProject();
              const { loadHttpClientFromDisk } = await import('../services/httpClientPersistence');
              const loaded = await loadHttpClientFromDisk(path);
              if (loaded) hydrateHttpClientFromDisk(loaded);
            }
          } catch (error) {
            logger.warn('project', 'Failed to restore workspace / HTTP Client:', error);
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
          // (b) the project actually has content to analyze. On in-window
          // switch this probe (read + optional AGENTS/CLAUDE load + glob) is
          // deferred so focus feels instant; cold open still awaits it.
          const probeTms = async () => {
            try {
              await invoke('read_file', { path: `${path}/TMS.md` });
              // Only write if still focused on this project (rapid A→B→C).
              if (get().currentProject?.path === path) set({ noTmsFile: false });
            } catch {
              let hasForeignInstructions = false;
              try {
                const { loadProjectInstructions } = await import('../services/agent/projectInstructions');
                const bundle = await loadProjectInstructions(path);
                hasForeignInstructions = !!bundle.foreignPrimary;
              } catch {
                hasForeignInstructions = false;
              }
              if (get().currentProject?.path !== path) return;
              if (hasForeignInstructions) {
                set({ noTmsFile: false });
              } else {
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
                if (get().currentProject?.path === path) set({ noTmsFile: hasContent });
              }
            }
          };
          if (isInWindowSwitch) {
            void probeTms();
          } else {
            await probeTms();
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
            t('welcome.clearProjectsConfirm').replace('{count}', String(count)),
            { title: t('welcome.clearProjects'), kind: 'warning' }
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
            const closed = await get().closeProject();
            // User declined the close (busy/dirty confirm) — abort
            if (!closed) return;
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
          } else {
            // F2 MDI: deleting a NON-current project must also stop its live
            // background run(s) and drop its Rust registry entry — otherwise the
            // agent keeps writing under a directory we're deleting, and a stale
            // ActiveProject keeps a now-deleted path as a valid clamp cwd.
            try {
              const { useParallelTaskStore } = await import('./parallelTaskStore');
              const store = useParallelTaskStore.getState();
              for (const r of store.runs.values()) {
                if (r.projectPath === projectPath && (r.status === 'running' || r.status === 'queued')) {
                  store.abort(r.id);
                }
              }
            } catch { /* best-effort */ }
            invoke('clear_active_project', { projectId }).catch(() => {});
            if (devServerManager.getProjectPath() === projectPath) {
              // Stop the dev server only if it belongs to the project being deleted
              await devServerManager.stop().catch(() => {});
              useLayoutStore.getState().clearDevServer();
            }
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

      closeProject: async (options?: { force?: boolean }) => {
        const { currentProject } = get();

        // Closing cancels the in-flight run (tearDownProject → cancelLoop);
        // give the user the chance to keep it working instead. `force` is
        // for non-interactive closes (deleted project dir) where prompting
        // would strand the app on a modal nobody can answer meaningfully.
        if (!options?.force) {
          const proceedBusy = await confirmCancelActiveRun('close');
          if (!proceedBusy) return false;

          const editorState = useEditorRepository.getState();
          const hasDirtyFiles = editorState.openFiles.some(f => f.isDirty);
          if (hasDirtyFiles) {
            const dirtyCount = editorState.openFiles.filter(f => f.isDirty).length;
            const ok = await tauriConfirm(`There are ${dirtyCount} unsaved file(s). Close project and discard changes?`, { title: 'Unsaved changes', kind: 'warning' });
            if (!ok) return false;
          }
        }

        // Save current project state before closing
        if (currentProject) {
          await get().saveProjectState().catch(console.error);
          // Save the chat session BEFORE teardown wipes it. Centralised
          // here for EVERY close path (Home button, keyboard shortcut,
          // sign-out, status monitor) — sign-out used to do this from the
          // outside and the other paths could lose the final seconds of
          // conversation between the last auto-save tick and the close.
          await useChatStore.getState().cleanupOnExit(currentProject.path).catch(() => {});
        }
        // Agent cancel is owned by tearDownProject (scoped to this project).
        tearDownProject();
        // User is now back on Welcome — remember that so a restart doesn't
        // auto-reopen the project they just closed.
        set({ welcomeScreen: 'hero', noTmsFile: false, tmsBootstrapping: false });
        return true;
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
