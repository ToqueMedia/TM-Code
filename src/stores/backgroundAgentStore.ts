import { create } from 'zustand'

export type BackgroundAgentStatus = 'running' | 'completed' | 'error' | 'cancelled'

export interface BackgroundAgent {
  id: string
  question: string
  status: BackgroundAgentStatus
  result: string | null
  toolsCalled: number
  totalTokens: number
  progressText: string
  startedAt: number
  completedAt: number | null
  abortController: AbortController
}

interface BackgroundAgentState {
  agents: Map<string, BackgroundAgent>
}

interface BackgroundAgentActions {
  addAgent: (agent: BackgroundAgent) => void
  updateProgress: (id: string, progressText: string, toolsCalled?: number, totalTokens?: number) => void
  completeAgent: (id: string, result: string) => void
  failAgent: (id: string, error: string) => void
  cancelAgent: (id: string) => void
  cancelAll: () => void
  removeCompleted: () => void
  getRunningCount: () => number
  getAll: () => BackgroundAgent[]
}

export const useBackgroundAgentStore = create<BackgroundAgentState & BackgroundAgentActions>()((set, get) => ({
  agents: new Map(),

  addAgent: (agent) => {
    set(state => {
      const next = new Map(state.agents)
      next.set(agent.id, agent)
      return { agents: next }
    })
  },

  updateProgress: (id, progressText, toolsCalled, totalTokens) => {
    set(state => {
      const agent = state.agents.get(id)
      if (!agent || agent.status !== 'running') return state
      const next = new Map(state.agents)
      next.set(id, {
        ...agent,
        progressText,
        ...(toolsCalled !== undefined && { toolsCalled }),
        ...(totalTokens !== undefined && { totalTokens }),
      })
      return { agents: next }
    })
  },

  completeAgent: (id, result) => {
    set(state => {
      const agent = state.agents.get(id)
      if (!agent) return state
      const next = new Map(state.agents)
      next.set(id, { ...agent, status: 'completed', result, completedAt: Date.now() })
      return { agents: next }
    })
  },

  failAgent: (id, error) => {
    set(state => {
      const agent = state.agents.get(id)
      if (!agent) return state
      const next = new Map(state.agents)
      next.set(id, { ...agent, status: 'error', result: error, completedAt: Date.now() })
      return { agents: next }
    })
  },

  cancelAgent: (id) => {
    const agent = get().agents.get(id)
    if (!agent || agent.status !== 'running') return
    agent.abortController.abort()
    set(state => {
      const next = new Map(state.agents)
      next.set(id, { ...agent, status: 'cancelled', completedAt: Date.now() })
      return { agents: next }
    })
  },

  cancelAll: () => {
    const agents = get().agents
    agents.forEach(agent => {
      if (agent.status === 'running') agent.abortController.abort()
    })
    set(state => {
      const next = new Map(state.agents)
      next.forEach((agent, id) => {
        if (agent.status === 'running') {
          next.set(id, { ...agent, status: 'cancelled', completedAt: Date.now() })
        }
      })
      return { agents: next }
    })
  },

  removeCompleted: () => {
    set(state => {
      const next = new Map(state.agents)
      next.forEach((agent, id) => {
        if (agent.status !== 'running') next.delete(id)
      })
      return { agents: next }
    })
  },

  getRunningCount: () => {
    let count = 0
    get().agents.forEach(a => { if (a.status === 'running') count++ })
    return count
  },

  getAll: () => Array.from(get().agents.values()),
}))
