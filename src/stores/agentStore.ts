import { create } from 'zustand'
import { AgentStatus } from '../types/agent'

interface AgentState {
  status: AgentStatus
  error: string | null
}

interface AgentActions {
  setStatus: (status: AgentStatus) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useAgentStore = create<AgentState & AgentActions>()((set) => ({
  status: 'idle',
  error: null,

  setStatus: (status: AgentStatus) => {
    set({ status })
  },

  setError: (error: string | null) => {
    set({ error })
  },

  reset: () => {
    set({
      status: 'idle',
      error: null,
    })
  },
}))
