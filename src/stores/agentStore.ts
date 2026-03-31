import { create } from 'zustand'
import { AgentStatus } from '../types/agent'

export interface QueuePositionInfo {
  position: number
  total: number
}

interface AgentState {
  status: AgentStatus
  error: string | null
  queuePosition: QueuePositionInfo | null
}

interface AgentActions {
  setStatus: (status: AgentStatus) => void
  setError: (error: string | null) => void
  setQueuePosition: (pos: QueuePositionInfo | null) => void
  reset: () => void
}

export const useAgentStore = create<AgentState & AgentActions>()((set) => ({
  status: 'idle',
  error: null,
  queuePosition: null,

  setStatus: (status: AgentStatus) => {
    set({ status })
  },

  setError: (error: string | null) => {
    set({ error })
  },

  setQueuePosition: (pos: QueuePositionInfo | null) => {
    set({ queuePosition: pos })
  },

  reset: () => {
    set({
      status: 'idle',
      error: null,
      queuePosition: null,
    })
  },
}))
