import { create } from 'zustand'

export type ViewMode = 'chat' | 'generating' | 'preview' | 'editor' | 'settings' | 'data'
/** UI surface in the preview area. Derived from `devServer.projectKind` + static preview state. */
export type PreviewMode = 'server' | 'static' | 'api'
export type DevLogLevel = 'info' | 'warn' | 'error'

/** Event name for dev server log additions — shared between layoutStore (emit) and toolExecutor (listen). */
export const DEV_LOG_EVENT = 'devserver-log-added'

export interface DevServerLogEntry {
  id: number
  level: DevLogLevel
  text: string
  timestamp: number
}

export type ScaffoldPhase = null | 'installing' | 'starting' | 'ready' | 'error'

/**
 * Classification of the user's project for UI routing.
 *  - `frontend`  → main area shows iframe preview (Vite, Next, etc.)
 *  - `backend`   → main area shows HTTP Client panel (Express, Fastify, etc.)
 *  - `fullstack` → main area shows iframe preview; HTTP Client available as a
 *                  toggleable bottom drawer (monolithic: same URL; distributed:
 *                  separate frontend/backend URLs)
 */
export type ProjectKind = 'frontend' | 'backend' | 'fullstack'

export type DevServerStatus = 'starting' | 'running' | 'stopped' | 'error'

/**
 * Unified dev-server record. Replaces the legacy dual-slot model
 * (`frontendServer` + `backendServer`). One process per project. For fullstack
 * projects, both `frontendUrl` and `backendUrl` may populate from the same PID
 * (monolithic: equal; distributed: different ports).
 */
export interface DevServerInfo {
  pid: number
  projectKind: ProjectKind
  frontendUrl: string | null
  backendUrl: string | null
  status: DevServerStatus
}

interface LayoutState {
  viewMode: ViewMode
  previousViewMode: ViewMode | null
  isSidebarVisible: boolean
  isProjectsSidebarVisible: boolean
  /** Tracks if sidebar was open before entering preview — to restore on exit */
  projectsSidebarBeforePreview: boolean | null
  showTemplateSelector: boolean
  isPreviewServerLoading: boolean
  /** The single dev server for this project. Null when no server is active. */
  devServer: DevServerInfo | null
  /**
   * UI surface for the preview area. Derived from `devServer.projectKind`:
   *   backend → 'api', frontend | fullstack → 'server'.
   * `static` is used when viewing a standalone HTML file (no dev server).
   */
  previewMode: PreviewMode
  /** For fullstack projects: true when the HTTP Client drawer is expanded. */
  isHttpDrawerOpen: boolean
  /** Cross-component publish modal flag — both MinimalTitleBar and the
   *  PreviewView toolbar trigger the same modal so we keep a single source
   *  of truth here. The modal itself is mounted by MinimalTitleBar. */
  isPublishModalOpen: boolean
  previewHtmlContent: string | null
  previewSourcePath: string | null
  /** Incremented to signal the preview iframe should reload */
  previewReloadKey: number
  /** Dev server console output */
  devServerLogs: DevServerLogEntry[]
  isConsoleVisible: boolean
  /** True when the server poll timed out without becoming reachable */
  previewServerTimedOut: boolean
  /**
   * Reference count of open overlays that must cover the native preview webview.
   * On Windows/Linux the wry child webview is an OS child window that sits ABOVE
   * the DOM — CSS z-index can't layer HTML overlays (menus, dropdowns, dialogs)
   * above it. When overlayCount > 0, TauriWebview moves itself off-screen so the
   * HTML overlay is visible and clickable. Use pushOverlay/popOverlay around the
   * lifecycle of each HTML overlay that extends into the preview area.
   */
  overlayCount: number
  /** Current phase of the post-scaffold pipeline */
  scaffoldPhase: ScaffoldPhase
  scaffoldMessage: string
}

interface LayoutActions {
  setViewMode: (mode: ViewMode) => void
  toggleSidebar: () => void
  toggleProjectsSidebar: () => void
  setShowTemplateSelector: (show: boolean) => void
  setPreviewServerLoading: (loading: boolean) => void
  /** Initialize the dev server record when a process starts. */
  initDevServer: (info: { pid: number; projectKind: ProjectKind }) => void
  /** Update the frontend URL (iframe target). Marks devServer status=running. */
  setDevServerFrontendUrl: (url: string) => void
  /** Update the backend URL (HTTP Client base). Marks devServer status=running. */
  setDevServerBackendUrl: (url: string) => void
  setPreviewServerTimedOut: (timedOut: boolean) => void
  setStaticPreview: (html: string, sourcePath: string) => void
  /** Tear down the dev server record. Keeps logs so crash messages stay visible. */
  clearDevServer: () => void
  reloadPreview: () => void
  addDevServerLog: (text: string, level?: DevLogLevel) => void
  addDevServerLogs: (entries: Array<{ text: string; level: DevLogLevel }>) => void
  clearDevServerLogs: () => void
  /** Increment the overlay reference count. Pair with popOverlay in a cleanup. */
  pushOverlay: () => void
  /** Decrement the overlay reference count. Must match a prior pushOverlay. */
  popOverlay: () => void
  toggleConsole: () => void
  /** Toggle the HTTP Client drawer in fullstack projects. */
  toggleHttpDrawer: () => void
  /** Open / close the deploy publish modal. Single source of truth so both
   *  the title bar and the preview toolbar trigger the same dialog. */
  setPublishModalOpen: (open: boolean) => void
  goBack: () => void
  setScaffoldPhase: (phase: ScaffoldPhase, message?: string) => void
}

/** Derive preview mode from project kind. */
function previewModeFor(kind: ProjectKind): PreviewMode {
  return kind === 'backend' ? 'api' : 'server'
}

export const useLayoutStore = create<LayoutState & LayoutActions>()((set, get) => ({
  viewMode: 'chat',
  previousViewMode: null,
  isSidebarVisible: false,
  isProjectsSidebarVisible: false,
  projectsSidebarBeforePreview: null,
  showTemplateSelector: false,
  isPreviewServerLoading: false,
  devServer: null,
  previewMode: 'server',
  isHttpDrawerOpen: false,
  isPublishModalOpen: false,
  previewHtmlContent: null,
  previewSourcePath: null,
  previewReloadKey: 0,
  previewServerTimedOut: false,
  devServerLogs: [],
  isConsoleVisible: false,
  overlayCount: 0,
  scaffoldPhase: null,
  scaffoldMessage: '',

  setViewMode: (mode: ViewMode) => {
    const current = get().viewMode
    if (current === mode) return

    const state = get()

    // Entering preview — auto-hide projects sidebar, remember its state
    if (mode === 'preview' && current !== 'preview') {
      set({
        viewMode: mode,
        previousViewMode: current,
        projectsSidebarBeforePreview: state.isProjectsSidebarVisible,
        isProjectsSidebarVisible: false,
      })
      return
    }

    // Leaving preview — restore projects sidebar if it was open before
    if (current === 'preview' && mode !== 'preview') {
      const restore = state.projectsSidebarBeforePreview
      set({
        viewMode: mode,
        previousViewMode: current,
        projectsSidebarBeforePreview: null,
        ...(restore ? { isProjectsSidebarVisible: true } : {}),
      })
      return
    }

    set({
      viewMode: mode,
      previousViewMode: current,
    })
  },

  toggleSidebar: () => {
    set(state => ({ isSidebarVisible: !state.isSidebarVisible }))
  },

  toggleProjectsSidebar: () => {
    set(state => ({ isProjectsSidebarVisible: !state.isProjectsSidebarVisible }))
  },

  setShowTemplateSelector: (show: boolean) => {
    set({ showTemplateSelector: show })
  },

  setPreviewServerLoading: (loading: boolean) => {
    set({ isPreviewServerLoading: loading })
  },

  initDevServer: ({ pid, projectKind }) => {
    set({
      devServer: {
        pid,
        projectKind,
        frontendUrl: null,
        backendUrl: null,
        status: 'starting',
      },
      previewMode: previewModeFor(projectKind),
      isPreviewServerLoading: true,
      previewServerTimedOut: false,
      // Backend-only projects have no iframe — don't show a stale static preview.
      // Frontend/fullstack: clear so the iframe starts clean for the new server.
      previewHtmlContent: null,
      previewSourcePath: null,
    })
  },

  setDevServerFrontendUrl: (url: string) => {
    set(state => {
      if (!state.devServer) return {}
      return {
        devServer: { ...state.devServer, frontendUrl: url, status: 'running' },
        isPreviewServerLoading: false,
        previewServerTimedOut: false,
      }
    })
  },

  setDevServerBackendUrl: (url: string) => {
    set(state => {
      if (!state.devServer) return {}
      return {
        devServer: { ...state.devServer, backendUrl: url, status: 'running' },
        isPreviewServerLoading: false,
        previewServerTimedOut: false,
      }
    })
  },

  setPreviewServerTimedOut: (timedOut: boolean) => {
    set({ previewServerTimedOut: timedOut })
  },

  setStaticPreview: (html: string, sourcePath: string) => {
    set(state => ({
      previewHtmlContent: html,
      previewSourcePath: sourcePath,
      previewMode: 'static' as const,
      devServer: null,
      viewMode: 'preview' as const,
      previousViewMode: state.viewMode !== 'preview' ? state.viewMode : state.previousViewMode,
    }))
  },

  clearDevServer: () => {
    set({
      devServer: null,
      isPreviewServerLoading: false,
      previewServerTimedOut: false,
      // Keep logs and static preview; clearing the live server shouldn't
      // wipe other preview state.
      previewMode: 'server',
      isHttpDrawerOpen: false,
    })
  },

  reloadPreview: () => {
    set(state => ({ previewReloadKey: state.previewReloadKey + 1 }))
  },

  toggleHttpDrawer: () => {
    set(state => ({ isHttpDrawerOpen: !state.isHttpDrawerOpen }))
  },

  setPublishModalOpen: (open: boolean) => {
    set({ isPublishModalOpen: open })
  },

  addDevServerLog: (text: string, level: DevLogLevel = 'info') => {
    set(state => {
      const MAX_LOG_ENTRIES = 500
      const logs = state.devServerLogs
      const entry = { id: Date.now() + Math.random(), level, text, timestamp: Date.now() }
      const trimmed = logs.length >= MAX_LOG_ENTRIES ? logs.slice(-MAX_LOG_ENTRIES + 1) : logs
      return { devServerLogs: [...trimmed, entry] }
    })
    window.dispatchEvent(new CustomEvent(DEV_LOG_EVENT, { detail: { level } }))
  },

  addDevServerLogs: (entries) => {
    if (entries.length === 0) return
    // Single set() for N entries — critical on Windows, where WebView2
    // re-renders the PreviewView (subscribed to devServerLogs) on every
    // change, and that render is O(n) from filter() scans + non-virtualized
    // map(). Per-line additions would churn the UI even with IPC batching.
    let hasError = false
    let hasWarn = false
    set(state => {
      const MAX_LOG_ENTRIES = 500
      const now = Date.now()
      const created = entries.map((e, i) => {
        if (e.level === 'error') hasError = true
        else if (e.level === 'warn') hasWarn = true
        return { id: now + i + Math.random(), level: e.level, text: e.text, timestamp: now }
      })
      const logs = state.devServerLogs
      const combined = logs.concat(created)
      const trimmed = combined.length > MAX_LOG_ENTRIES
        ? combined.slice(combined.length - MAX_LOG_ENTRIES)
        : combined
      return { devServerLogs: trimmed }
    })
    const level: DevLogLevel = hasError ? 'error' : hasWarn ? 'warn' : 'info'
    window.dispatchEvent(new CustomEvent(DEV_LOG_EVENT, { detail: { level } }))
  },

  clearDevServerLogs: () => {
    set({ devServerLogs: [] })
  },

  pushOverlay: () => {
    set(state => ({ overlayCount: state.overlayCount + 1 }))
  },

  popOverlay: () => {
    // Floor at zero in case of mismatched pairs from component crashes.
    set(state => ({ overlayCount: Math.max(0, state.overlayCount - 1) }))
  },

  toggleConsole: () => {
    set(state => ({ isConsoleVisible: !state.isConsoleVisible }))
  },

  goBack: () => {
    const prev = get().previousViewMode
    if (prev) {
      set({
        viewMode: prev,
        previousViewMode: null,
      })
    } else {
      set({ viewMode: 'chat' })
    }
  },

  setScaffoldPhase: (phase, message) => {
    set({
      scaffoldPhase: phase,
      scaffoldMessage: message || '',
    })
    if (phase === 'ready') {
      setTimeout(() => {
        if (get().scaffoldPhase === 'ready') {
          set({ scaffoldPhase: null, scaffoldMessage: '' })
        }
      }, 3000)
    }
  },
}))

// ── Selectors ─────────────────────────────────────────────────────────────

/**
 * Primary preview URL. Resolves based on current `previewMode`:
 *  - 'server' → frontendUrl (iframe target)
 *  - 'api'    → backendUrl (HTTP Client base)
 *  - 'static' → null (host uses previewHtmlContent instead)
 */
export function selectPreviewUrl(state: LayoutState): string | null {
  if (state.previewMode === 'server') return state.devServer?.frontendUrl ?? null
  if (state.previewMode === 'api') return state.devServer?.backendUrl ?? null
  return null
}

/** Backend URL regardless of active preview mode (for HTTP Client baseUrl). */
export function selectBackendUrl(state: LayoutState): string | null {
  // Prefer explicit backendUrl; fall back to frontendUrl for monolithic
  // fullstack (Next.js API routes) where the one URL serves both.
  return state.devServer?.backendUrl ?? state.devServer?.frontendUrl ?? null
}

/** Frontend URL regardless of preview mode. */
export function selectFrontendUrl(state: LayoutState): string | null {
  return state.devServer?.frontendUrl ?? null
}

/** Project kind from the active dev server, or null when no server is running. */
export function selectProjectKind(state: LayoutState): ProjectKind | null {
  return state.devServer?.projectKind ?? null
}

/** PID of the dev server process, or null. */
export function selectDevServerPid(state: LayoutState): number | null {
  return state.devServer?.pid ?? null
}

/** True when the dev server is registered (starting or running). */
export function selectIsPreviewServerRunning(state: LayoutState): boolean {
  return !!state.devServer
}

/** True when the fullstack drawer should be *available* (project has a backend URL). */
export function selectHasBackendUrl(state: LayoutState): boolean {
  return !!state.devServer?.backendUrl
}
