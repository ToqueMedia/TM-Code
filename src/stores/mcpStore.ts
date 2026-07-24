import { create } from 'zustand'

export interface McpServerState {
  name: string
  status: 'starting' | 'running' | 'error' | 'stopped'
  error?: string
  tools: McpToolInfo[]
  transport: 'stdio' | 'remote'
  /** F4: project path scope, or `'__global__'` for app-wide servers. */
  scope?: string
}

export interface McpToolInfo {
  name: string
  description: string
  serverName: string
}

interface McpState {
  servers: McpServerState[]
  isInitializing: boolean
  error: string | null
}

interface McpActions {
  setServers: (servers: McpServerState[]) => void
  updateServer: (name: string, update: Partial<McpServerState>) => void
  addServer: (server: McpServerState) => void
  removeServer: (name: string) => void
  setInitializing: (v: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
  getRunningServers: () => McpServerState[]
  getTotalToolCount: () => number
}

export const useMcpStore = create<McpState & McpActions>()((set, get) => ({
  servers: [],
  isInitializing: false,
  error: null,

  setServers: (servers: McpServerState[]) => set({ servers, isInitializing: false, error: null }),

  updateServer: (name: string, update: Partial<McpServerState>) =>
    set((state) => ({
      servers: state.servers.map((s) =>
        s.name === name ? { ...s, ...update } : s
      ),
    })),

  addServer: (server: McpServerState) =>
    set((state) => ({
      servers: [...state.servers.filter((s) => s.name !== server.name), server],
    })),

  removeServer: (name: string) =>
    set((state) => ({
      servers: state.servers.filter((s) => s.name !== name),
    })),

  setInitializing: (isInitializing: boolean) => set({ isInitializing }),
  setError: (error: string | null) => set({ error, isInitializing: false }),
  reset: () => set({ servers: [], isInitializing: false, error: null }),

  getRunningServers: () => get().servers.filter(s => s.status === 'running'),
  getTotalToolCount: () => get().servers.reduce((sum, s) => sum + s.tools.length, 0),
}))
