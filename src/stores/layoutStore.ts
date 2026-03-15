import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export type ViewMode = 'chat' | 'generating' | 'preview' | 'editor'
export type PreviewMode = 'server' | 'static'

interface LayoutState {
  viewMode: ViewMode
  previousViewMode: ViewMode | null
  isSidebarVisible: boolean
  isPreviewServerRunning: boolean
  previewUrl: string | null
  previewServerPid: number | null
  previewMode: PreviewMode
  previewHtmlContent: string | null
  previewSourcePath: string | null
}

interface LayoutActions {
  setViewMode: (mode: ViewMode) => void
  toggleSidebar: () => void
  setPreviewServer: (url: string, pid: number) => void
  setStaticPreview: (html: string, sourcePath: string) => void
  clearPreviewServer: () => void
  goBack: () => void
}

export const useLayoutStore = create<LayoutState & LayoutActions>()((set, get) => ({
  viewMode: 'chat',
  previousViewMode: null,
  isSidebarVisible: false,
  isPreviewServerRunning: false,
  previewUrl: null,
  previewServerPid: null,
  previewMode: 'server',
  previewHtmlContent: null,
  previewSourcePath: null,

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

  setPreviewServer: (url: string, pid: number) => {
    set({
      isPreviewServerRunning: true,
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
    const pid = get().previewServerPid
    if (pid) {
      invoke('kill_process', { pid }).catch(() => {})
    }
    set({
      isPreviewServerRunning: false,
      previewUrl: null,
      previewServerPid: null,
      previewMode: 'server',
      previewHtmlContent: null,
      previewSourcePath: null,
    })
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
