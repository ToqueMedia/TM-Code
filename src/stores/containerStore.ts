import { create } from 'zustand';
import ContainerService, { ContainerInfo } from '../services/containerService';
import { logger } from '../utils/logger';

type IsolationMode = 'docker' | 'app-level' | 'none';

/** Monotonically increasing counter to detect stale async completions. */
let initGeneration = 0;

/** Whether Tauri event listeners have been set up. */
let listenersInitialized = false;

/** Set up backend event listeners once (deferred until first initContainer). */
async function ensureListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  try {
    const { listen } = await import('@tauri-apps/api/event');

    listen<string>('container-tools-ready', (event) => {
      logger.info('container', `Tools ready in ${event.payload}`);
    });

    listen<string>('container-tools-failed', (event) => {
      logger.warn('container', `Tool installation failed in ${event.payload}`);
    });
  } catch {
    // Tauri not ready — listeners skipped (e.g. test environment)
  }
}

interface ContainerState {
  containerInfo: ContainerInfo | null;
  isolationMode: IsolationMode;
  projectPath: string | null;
  projectId: string | null;
  dockerAvailable: boolean | null;
  isInitializing: boolean;
  error: string | null;
}

interface ContainerActions {
  checkDocker: () => Promise<boolean>;
  initContainer: (projectId: string, projectPath: string) => Promise<boolean>;
  stopContainer: (projectId: string) => Promise<void>;
  removeContainer: (projectId: string) => Promise<void>;
  clear: () => void;
}

export const useContainerStore = create<ContainerState & ContainerActions>((set, get) => ({
  containerInfo: null,
  isolationMode: 'none',
  projectPath: null,
  projectId: null,
  dockerAvailable: null,
  isInitializing: false,
  error: null,

  checkDocker: async () => {
    const available = await ContainerService.shared.checkDockerAvailable();
    set({ dockerAvailable: available });
    return available;
  },

  initContainer: async (projectId: string, projectPath: string) => {
    const gen = ++initGeneration;
    const isStale = () => initGeneration !== gen;

    // Lazy-init Tauri event listeners (safe: only after Tauri is ready)
    ensureListeners();

    let { dockerAvailable } = get();
    if (dockerAvailable === null) {
      dockerAvailable = await get().checkDocker();
    }

    if (!dockerAvailable) {
      logger.info('container', 'Docker daemon not running — using app-level isolation');
    }

    // ── Step 1: activate app-level isolation IMMEDIATELY ─────────
    try {
      await ContainerService.shared.setActiveProject(projectId, projectPath);
      if (isStale()) {
        ContainerService.shared.clearActiveProject(projectId).catch(() => {});
        return false;
      }
      set({
        isInitializing: false,
        error: null,
        projectPath,
        projectId,
        containerInfo: null,
        isolationMode: 'app-level',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      set({ isInitializing: false, error: msg, isolationMode: 'none' });
      return false;
    }

    // ── Step 2: try Docker upgrade in background ─────────────────
    if (dockerAvailable) {
      (async () => {
        try {
          // Cleanup orphans, but exclude the container for THIS project
          const removed = await ContainerService.shared.cleanupOrphanedContainers(projectId);
          if (removed > 0) {
            logger.info('container', `Cleaned up ${removed} orphaned container(s)`);
          }
          if (isStale()) return;

          const info = await ContainerService.shared.createContainer(projectId, projectPath);
          if (isStale()) {
            ContainerService.shared.stopContainer(projectId).catch(() => {});
            return;
          }

          // Upgrade from app-level to Docker
          set({
            containerInfo: info,
            isolationMode: 'docker',
          });
          logger.info('container', `Upgraded to Docker container ${info.containerName}`);
        } catch (error) {
          if (isStale()) return;
          logger.warn('container', 'Docker upgrade failed, staying on app-level:', error);
        }
      })();
    }

    return true;
  },

  stopContainer: async (projectId: string) => {
    const { isolationMode } = get();
    try {
      if (isolationMode === 'docker') {
        await ContainerService.shared.stopContainer(projectId);
      }
      await ContainerService.shared.clearActiveProject(projectId);
    } catch (error) {
      logger.warn('container', 'Failed to stop/clear project isolation:', error);
    }
    set({ containerInfo: null, isolationMode: 'none', projectPath: null, projectId: null });
  },

  removeContainer: async (projectId: string) => {
    const { isolationMode } = get();
    try {
      if (isolationMode === 'docker') {
        await ContainerService.shared.removeContainer(projectId);
      }
      await ContainerService.shared.clearActiveProject(projectId);
    } catch (error) {
      logger.warn('container', 'Failed to remove container:', error);
    }
    set({ containerInfo: null, isolationMode: 'none', projectPath: null, projectId: null });
  },

  clear: () => {
    set({
      containerInfo: null,
      isolationMode: 'none',
      projectPath: null,
      projectId: null,
      isInitializing: false,
      error: null,
    });
  },
}));

// ─── Convenience selectors ───────────────────────────────────────────────────

/** True when project isolation is active (either Docker or app-level). */
export function isProjectIsolated(): boolean {
  return useContainerStore.getState().isolationMode !== 'none';
}

/** True only when running inside a Docker container. */
export function isContainerActive(): boolean {
  return useContainerStore.getState().isolationMode === 'docker';
}

/** Get the project path of the isolated project. */
export function getContainerProjectPath(): string | null {
  return useContainerStore.getState().projectPath;
}

export default useContainerStore;
