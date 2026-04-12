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

interface LayoutState {
  viewMode: ViewMode
  previousViewMode: ViewMode | null
  isSidebarVisible: boolean
  isProjectsSidebarVisible: boolean
  /** Tracks if sidebar was open before entering preview — to restore on exit */
  projectsSidebarBeforePreview: boolean | null
  showTemplateSelector: boolean
  isPreviewServerRunning: boolean
  isPreviewServerLoading: boolean
  previewUrl: string | null
  previewServerPid: number | null
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
  setPreviewServer: (url: string, pid: number, mode?: PreviewMode) => void
  setPreviewServerTimedOut: (timedOut: boolean) => void
  setStaticPreview: (html: string, sourcePath: string) => void
  clearPreviewServer: () => void
  reloadPreview: () => void
  addDevServerLog: (text: string, level?: DevLogLevel) => void
  clearDevServerLogs: () => void
  toggleConsole: () => void
  togglePreviewMode: () => void
  goBack: () => void
  setScaffoldPhase: (phase: ScaffoldPhase, message?: string) => void
}

export const useLayoutStore = create<LayoutState & LayoutActions>()((set, get) => ({
  viewMode: 'chat',
  previousViewMode: null,
  isSidebarVisible: false,
  isProjectsSidebarVisible: false,
  projectsSidebarBeforePreview: null,
  showTemplateSelector: false,
  isPreviewServerRunning: false,
  isPreviewServerLoading: false,
  previewUrl: null,
  previewServerPid: null,
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
    set({
      isPreviewServerRunning: true,
      isPreviewServerLoading: false,
      previewServerTimedOut: false,
      previewUrl: url,
      previewServerPid: pid,
      previewMode: mode || 'server',
      previewHtmlContent: null,
      previewSourcePath: null,
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
      previewUrl: null,
      isPreviewServerRunning: false,
      viewMode: 'preview' as const,
      previousViewMode: state.viewMode !== 'preview' ? state.viewMode : state.previousViewMode,
    }))
  },

  clearPreviewServer: () => {
    // Resets preview UI state but preserves logs so crash messages stay visible.
    // Killing the process is devServerManager's job.
    set({
      isPreviewServerRunning: false,
      isPreviewServerLoading: false,
      previewServerTimedOut: false,
      previewUrl: null,
      previewServerPid: null,
      previewMode: 'server',
      previewHtmlContent: null,
      previewSourcePath: null,
      previewReloadKey: 0,
    })
  },

  reloadPreview: () => {
    set(state => ({ previewReloadKey: state.previewReloadKey + 1 }))
  },

  togglePreviewMode: () => {
    set(state => ({
      // Cycle server ↔ api; if in static mode, fall back to server
      previewMode: state.previewMode === 'server' ? 'api'
        : state.previewMode === 'api' ? 'server'
        : 'server',
    }))
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
