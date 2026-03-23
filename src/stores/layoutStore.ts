import { create } from 'zustand'

export type ViewMode = 'chat' | 'generating' | 'preview' | 'editor' | 'settings'
export type PreviewMode = 'server' | 'static'
export type DevLogLevel = 'info' | 'warn' | 'error'

export interface DevServerLogEntry {
  id: number
  level: DevLogLevel
  text: string
  timestamp: number
}

interface LayoutState {
  viewMode: ViewMode
  previousViewMode: ViewMode | null
  isSidebarVisible: boolean
  isProjectsSidebarVisible: boolean
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
}

interface LayoutActions {
  setViewMode: (mode: ViewMode) => void
  toggleSidebar: () => void
  toggleProjectsSidebar: () => void
  setShowTemplateSelector: (show: boolean) => void
  setPreviewServerLoading: (loading: boolean) => void
  setPreviewServer: (url: string, pid: number) => void
  setStaticPreview: (html: string, sourcePath: string) => void
  clearPreviewServer: () => void
  reloadPreview: () => void
  addDevServerLog: (text: string, level?: DevLogLevel) => void
  clearDevServerLogs: () => void
  toggleConsole: () => void
  goBack: () => void
}

export const useLayoutStore = create<LayoutState & LayoutActions>()((set, get) => ({
  viewMode: 'chat',
  previousViewMode: null,
  isSidebarVisible: false,
  isProjectsSidebarVisible: false,
  showTemplateSelector: false,
  isPreviewServerRunning: false,
  isPreviewServerLoading: false,
  previewUrl: null,
  previewServerPid: null,
  previewMode: 'server',
  previewHtmlContent: null,
  previewSourcePath: null,
  previewReloadKey: 0,
  devServerLogs: [],
  isConsoleVisible: false,

  setViewMode: (mode: ViewMode) => {
    const current = get().viewMode
    if (current === mode) return
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

  setPreviewServer: (url: string, pid: number) => {
    set({
      isPreviewServerRunning: true,
      isPreviewServerLoading: false,
      previewUrl: url,
      previewServerPid: pid,
      previewMode: 'server',
      previewHtmlContent: null,
      previewSourcePath: null,
    })
  },

  setStaticPreview: (html: string, sourcePath: string) => {
    const current = get().viewMode
    set({
      previewHtmlContent: html,
      previewSourcePath: sourcePath,
      previewMode: 'static',
      previewUrl: null,
      isPreviewServerRunning: false,
      viewMode: 'preview',
      previousViewMode: current !== 'preview' ? current : get().previousViewMode,
    })
  },

  clearPreviewServer: () => {
    // Resets preview UI state but preserves logs so crash messages stay visible.
    // Killing the process is devServerManager's job.
    set({
      isPreviewServerRunning: false,
      isPreviewServerLoading: false,
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

  addDevServerLog: (text: string, level: DevLogLevel = 'info') => {
    set(state => ({
      devServerLogs: [
        ...state.devServerLogs,
        { id: Date.now() + Math.random(), level, text, timestamp: Date.now() },
      ],
    }))
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
}))
