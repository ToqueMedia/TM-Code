import { create } from 'zustand'

export type DataSource = 'dev' | 'prod'
export type PageSize = 10 | 20 | 50 | 100

export interface TableInfoColumn {
  name: string
  type: string
  notNull: boolean
  isPrimaryKey: boolean
}

interface DataViewerState {
  source: DataSource
  /** Currently selected table; null until a project's tables resolve. */
  activeTable: string | null
  page: number
  pageSize: PageSize
}

interface DataViewerActions {
  setSource: (source: DataSource, projectId?: string) => void
  setActiveTable: (table: string | null) => void
  setPage: (page: number) => void
  setPageSize: (size: PageSize) => void
  /** Restore the saved source preference for a project, if any. */
  hydrateFromProject: (projectId: string, fallback: DataSource) => void
  reset: () => void
}

const SOURCE_STORAGE_PREFIX = 'data-viewer-source:'

function loadStoredSource(projectId: string): DataSource | null {
  try {
    const raw = localStorage.getItem(SOURCE_STORAGE_PREFIX + projectId)
    if (raw === 'dev' || raw === 'prod') return raw
  } catch {}
  return null
}

function storeSource(projectId: string, source: DataSource) {
  try {
    localStorage.setItem(SOURCE_STORAGE_PREFIX + projectId, source)
  } catch {}
}

export const useDataViewerStore = create<DataViewerState & DataViewerActions>()((set) => ({
  source: 'dev',
  activeTable: null,
  page: 1,
  pageSize: 20,

  setSource: (source, projectId) => {
    if (projectId) storeSource(projectId, source)
    set({ source, page: 1, activeTable: null })
  },

  setActiveTable: (table) => {
    set({ activeTable: table, page: 1 })
  },

  setPage: (page) => {
    set({ page: Math.max(1, page) })
  },

  setPageSize: (size) => {
    set({ pageSize: size, page: 1 })
  },

  hydrateFromProject: (projectId, fallback) => {
    const stored = loadStoredSource(projectId)
    set({ source: stored ?? fallback, activeTable: null, page: 1 })
  },

  reset: () => {
    set({ source: 'dev', activeTable: null, page: 1, pageSize: 20 })
  },
}))
