import { create } from 'zustand'

export type ViewMode = 'chat' | 'generating' | 'preview' | 'editor' | 'settings'
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
 * Information about one running dev server.
 * In fullstack projects both `frontendServer` and `backendServer` can be set
 * simultaneously — the preview routing picks the active one based on
 * `previewMode`.
 */
export interface ServerSlot {
  url: string
  pid: number
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
  /** Frontend dev server (7773). When set, PreviewView shows the iframe. */
  frontendServer: ServerSlot | null
  /** Backend dev server (7777). When frontend is absent, preview routes to HttpClientPanel. */
  backendServer: ServerSlot | null
  /**
   * User-selected preview surface. Default follows priority frontend > backend,
   * but user can toggle via `togglePreviewMode` when both servers are running.
   */
  previewMode: PreviewMode
  previewHtmlContent: string | null
  previewSourcePath: string | null
  /** Incremented to signal the preview iframe should reload */
  previewReloadKey: number
  /** Dev server console output */
  devServerLogs: DevServerLogEntry[]
  isConsoleVisible: boolean
  /** True when the server poll timed out without becoming reachable */
  previewServerTimedOut: boolean
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
  /**
   * Register a running dev server in its slot.
   *
   * `mode` is only used as a hint when the caller already knows the type:
   *  - 'server' / 'static' → stores in `frontendServer` (or sets static preview via setStaticPreview)
   *  - 'api' → stores in `backendServer`
   *
   * Preview routing priority: if frontend exists, show PreviewView (iframe).
   * Only fall back to HttpClientPanel (api mode) when no frontend is running.
   * User can toggle via `togglePreviewMode` when both slots are populated.
   */
  setPreviewServer: (url: string, pid: number, mode?: PreviewMode) => void
  setPreviewServerTimedOut: (timedOut: boolean) => void
  setStaticPreview: (html: string, sourcePath: string) => void
  /**
   * Clear one or both dev server slots.
   *  - undefined / 'all': clears both and resets preview
   *  - 'frontend': clears frontend slot only; preview falls back to backend if present
   *  - 'backend': clears backend slot only
   */
  clearPreviewServer: (which?: 'frontend' | 'backend' | 'all') => void
  reloadPreview: () => void
  addDevServerLog: (text: string, level?: DevLogLevel) => void
  clearDevServerLogs: () => void
  toggleConsole: () => void
  togglePreviewMode: () => void
  goBack: () => void
  setScaffoldPhase: (phase: ScaffoldPhase, message?: string) => void
}

/** Derive preview mode default from which server slots are active. */
function defaultModeFor(
  frontend: ServerSlot | null,
  backend: ServerSlot | null,
  staticContent: string | null,
): PreviewMode {
  if (staticContent) return 'static'
  if (frontend) return 'server'
  if (backend) return 'api'
  return 'server'
}

export const useLayoutStore = create<LayoutState & LayoutActions>()((set, get) => ({
  viewMode: 'chat',
  previousViewMode: null,
  isSidebarVisible: false,
  isProjectsSidebarVisible: false,
  projectsSidebarBeforePreview: null,
  showTemplateSelector: false,
  isPreviewServerLoading: false,
  frontendServer: null,
  backendServer: null,
  previewMode: 'server',
  previewHtmlContent: null,
  previewSourcePath: null,
  previewReloadKey: 0,
  previewServerTimedOut: false,
  devServerLogs: [],
  isConsoleVisible: false,
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

  setPreviewServer: (url: string, pid: number, mode?: PreviewMode) => {
    set(state => {
      const slot: ServerSlot = { url, pid }
      // Route by mode hint: 'api' → backend, anything else → frontend.
      // Both slots can coexist: starting a frontend does NOT wipe the backend.
      const frontendServer = mode === 'api' ? state.frontendServer : slot
      const backendServer = mode === 'api' ? slot : state.backendServer

      // Frontend takes priority: when a frontend just arrived, force 'server'
      // mode regardless of prior state (this covers the fullstack case where
      // backend boots first and sets mode='api', then frontend arrives and
      // must preempt). When only backend arrives with a frontend already
      // present, preserve the current mode — the user is likely viewing the
      // frontend and we don't want to yank them away.
      let nextMode: PreviewMode
      if (mode === 'api') {
        nextMode = frontendServer ? state.previewMode : 'api'
      } else {
        // frontend arrival (explicit 'server' or no hint)
        nextMode = 'server'
      }

      return {
        frontendServer,
        backendServer,
        isPreviewServerLoading: false,
        previewServerTimedOut: false,
        previewMode: nextMode,
        previewHtmlContent: null,
        previewSourcePath: null,
      }
    })
  },

  setPreviewServerTimedOut: (timedOut: boolean) => {
    set({ previewServerTimedOut: timedOut })
  },

  setStaticPreview: (html: string, sourcePath: string) => {
    // Functional set to read state atomically (avoids stale closure on previousViewMode)
    set(state => ({
      previewHtmlContent: html,
      previewSourcePath: sourcePath,
      previewMode: 'static' as const,
      frontendServer: null,
      backendServer: null,
      viewMode: 'preview' as const,
      previousViewMode: state.viewMode !== 'preview' ? state.viewMode : state.previousViewMode,
    }))
  },

  clearPreviewServer: (which: 'frontend' | 'backend' | 'all' = 'all') => {
    set(state => {
      const frontendServer = which === 'frontend' || which === 'all' ? null : state.frontendServer
      const backendServer = which === 'backend' || which === 'all' ? null : state.backendServer

      // Resets preview UI state but preserves logs so crash messages stay visible.
      // Killing the process is devServerManager's job.
      return {
        frontendServer,
        backendServer,
        isPreviewServerLoading: false,
        previewServerTimedOut: false,
        previewMode: defaultModeFor(frontendServer, backendServer, null),
        previewHtmlContent: which === 'all' ? null : state.previewHtmlContent,
        previewSourcePath: which === 'all' ? null : state.previewSourcePath,
        previewReloadKey: which === 'all' ? 0 : state.previewReloadKey,
      }
    })
  },

  reloadPreview: () => {
    set(state => ({ previewReloadKey: state.previewReloadKey + 1 }))
  },

  togglePreviewMode: () => {
    set(state => {
      // Cycle server ↔ api; 'static' collapses back to whichever slot is populated.
      if (state.previewMode === 'server') {
        return { previewMode: state.backendServer ? 'api' : 'server' }
      }
      if (state.previewMode === 'api') {
        return { previewMode: state.frontendServer ? 'server' : 'api' }
      }
      // static — fall back to default based on active slots
      return { previewMode: defaultModeFor(state.frontendServer, state.backendServer, null) }
    })
  },

  addDevServerLog: (text: string, level: DevLogLevel = 'info') => {
    set(state => {
      const MAX_LOG_ENTRIES = 500
      const logs = state.devServerLogs
      const entry = { id: Date.now() + Math.random(), level, text, timestamp: Date.now() }
      // Trim oldest entries when exceeding limit to prevent memory growth
      const trimmed = logs.length >= MAX_LOG_ENTRIES ? logs.slice(-MAX_LOG_ENTRIES + 1) : logs
      return { devServerLogs: [...trimmed, entry] }
    })
    // Notify any waiters (e.g., read_dev_server_logs tool waiting for
    // runtime errors to arrive from the preview WebView IPC pipeline).
    window.dispatchEvent(new CustomEvent(DEV_LOG_EVENT, { detail: { level } }))
  },

  clearDevServerLogs: () => {
    set({ devServerLogs: [] })
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
    // Auto-clear "ready" after 3 seconds
    if (phase === 'ready') {
      setTimeout(() => {
        if (get().scaffoldPhase === 'ready') {
          set({ scaffoldPhase: null, scaffoldMessage: '' })
        }
      }, 3000)
    }
  },
}))

// ── Legacy selectors ──────────────────────────────────────────────────────
// Computed views of the dual-slot state for components that still use the
// pre-refactor single-server model. Prefer subscribing directly to
// `frontendServer` / `backendServer` / `previewMode` in new code.

/**
 * Primary preview URL. Resolves based on current `previewMode`:
 *  - 'server' → frontend url
 *  - 'api' → backend url
 *  - 'static' → null (host uses previewHtmlContent instead)
 */
export function selectPreviewUrl(state: LayoutState): string | null {
  if (state.previewMode === 'server') return state.frontendServer?.url ?? null
  if (state.previewMode === 'api') return state.backendServer?.url ?? null
  return null
}

/** PID corresponding to `selectPreviewUrl`. */
export function selectPreviewServerPid(state: LayoutState): number | null {
  if (state.previewMode === 'server') return state.frontendServer?.pid ?? null
  if (state.previewMode === 'api') return state.backendServer?.pid ?? null
  return null
}

/** True when ANY dev server (frontend or backend) is registered. */
export function selectIsPreviewServerRunning(state: LayoutState): boolean {
  return !!(state.frontendServer || state.backendServer)
}
