import { create } from 'zustand'
import { AgentStatus } from '../types/agent'

export interface QueuePositionInfo {
  position: number
  total: number
}

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTask {
  id: string
  description: string
  status: AgentTaskStatus
}

interface AgentState {
  status: AgentStatus
  error: string | null
  queuePosition: QueuePositionInfo | null
  /** Tasks the agent is tracking for the current message. Displayed in the chat UI. */
  tasks: AgentTask[]
}

interface AgentActions {
  setStatus: (status: AgentStatus) => void
  setError: (error: string | null) => void
  setQueuePosition: (pos: QueuePositionInfo | null) => void
  // Task management
  setTasks: (tasks: AgentTask[]) => void
  updateTaskStatus: (taskId: string, status: AgentTaskStatus) => void
  clearTasks: () => void
  reset: () => void
}

export const useAgentStore = create<AgentState & AgentActions>()((set) => ({
  status: 'idle',
  error: null,
  queuePosition: null,
  tasks: [],

  setStatus: (status: AgentStatus) => {
    set({ status })
  },

  setError: (error: string | null) => {
    set({ error })
  },

  setQueuePosition: (pos: QueuePositionInfo | null) => {
    set({ queuePosition: pos })
  },

  setTasks: (tasks: AgentTask[]) => {
    set({ tasks })
  },

  updateTaskStatus: (taskId: string, status: AgentTaskStatus) => {
    set(state => ({
      tasks: state.tasks.map(t =>
        t.id === taskId ? { ...t, status } : t
      ),
    }))
  },

  clearTasks: () => {
    set({ tasks: [] })
  },

  reset: () => {
    set({
      status: 'idle',
      error: null,
      queuePosition: null,
      tasks: [],
    })
  },
}))
