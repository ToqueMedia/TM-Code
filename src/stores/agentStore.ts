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
  /**
   * Phase A telemetry: cumulative count of times the safe tool pool blocked
   * a tool from starting because of an in-flight non-concurrency-safe sibling.
   * Each increment represents a "would-have-been-a-race" today's Promise.all
   * dispatch could not have prevented. Surfaced in Settings → Experimental
   * for dogfood validation. Reset on session start.
   */
  poolConcurrencyConflictsAvoided: number
}

interface AgentActions {
  setStatus: (status: AgentStatus) => void
  setError: (error: string | null) => void
  setQueuePosition: (pos: QueuePositionInfo | null) => void
  // Task management
  setTasks: (tasks: AgentTask[]) => void
  updateTaskStatus: (taskId: string, status: AgentTaskStatus) => void
  clearTasks: () => void
  // Phase A telemetry mirror
  bumpPoolConflictsAvoided: (delta: number) => void
  resetPoolConflictsAvoided: () => void
  reset: () => void
}

export const useAgentStore = create<AgentState & AgentActions>()((set) => ({
  status: 'idle',
  error: null,
  queuePosition: null,
  tasks: [],
  poolConcurrencyConflictsAvoided: 0,

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

  bumpPoolConflictsAvoided: (delta: number) => {
    if (delta <= 0) return
    set(state => ({ poolConcurrencyConflictsAvoided: state.poolConcurrencyConflictsAvoided + delta }))
  },

  resetPoolConflictsAvoided: () => {
    set({ poolConcurrencyConflictsAvoided: 0 })
  },

  reset: () => {
    set({
      status: 'idle',
      error: null,
      queuePosition: null,
      tasks: [],
      poolConcurrencyConflictsAvoided: 0,
    })
  },
}))
