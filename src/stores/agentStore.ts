import { create } from 'zustand'
import { AgentStatus } from '../types/agent'

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTask {
  id: string
  description: string
  status: AgentTaskStatus
}

interface AgentState {
  status: AgentStatus
  error: string | null
  /** Tasks the agent is tracking for the current message. Displayed in the chat UI. */
  tasks: AgentTask[]
  /** Model name reported by the backend via X-Model-Name header. */
  modelName: string | null
  /** Provider name reported by the backend via X-Model-Provider header. */
  modelProvider: string | null
  /**
   * Reasoning capability of the active model, reported by the backend via
   * X-Model-Thinking-Mode header. Authoritative source for the toggle's
   * visibility — the frontend's per-plan profile is only a fallback for
   * pre-handshake state (before the first response arrives).
   */
  thinkingMode: 'none' | 'toggleable' | 'mandatory' | null
  /**
   * Context window size (tokens) reported by the backend via the
   * `X-Model-Context-Window` header. The agent's compression threshold uses
   * this exact value, so surfacing it here keeps the
   * ContextWindowIndicator's percentage in lockstep with reality — instead
   * of reading the plan profile's static value (200K for the GLM-5.1 shape,
   * which is wrong for any BYOK model with a different window). Null until
   * the first response arrives.
   */
  modelContextWindow: number | null
  /**
   * Whether the most recent response was actually served via BYOK (the
   * server-side X-BYOK-Active header). This is the authoritative source for
   * the chat-header pill — the byokStore.enabled toggle says what the user
   * configured, but only this header confirms what the server did. Drifts
   * back to false when a non-BYOK request follows a BYOK one.
   */
  byokActive: boolean
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
  // Model metadata from backend response headers
  setModelInfo: (name: string | null, provider: string | null, thinkingMode?: 'none' | 'toggleable' | 'mandatory' | null, contextWindow?: number | null) => void
  setByokActive: (active: boolean) => void
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
  tasks: [],
  modelName: null,
  modelProvider: null,
  thinkingMode: null,
  modelContextWindow: null,
  byokActive: false,
  poolConcurrencyConflictsAvoided: 0,

  setStatus: (status: AgentStatus) => {
    set({ status })
  },

  setError: (error: string | null) => {
    set({ error })
  },

  setModelInfo: (name, provider, thinkingMode, contextWindow) => {
    set({
      modelName: name,
      modelProvider: provider,
      // Only overwrite thinkingMode when the caller actually passed one — keeps
      // a stale value alive across handshake-less updates rather than wiping
      // the toggle every refresh.
      ...(thinkingMode !== undefined ? { thinkingMode } : {}),
      // Same opt-in pattern for context window — only updates when the
      // caller provided a value (null is treated as "clear", undefined as
      // "leave alone"). Lets one header (X-Model-Context-Window) drive
      // both the agent's threshold AND the indicator pill from a single
      // source of truth.
      ...(contextWindow !== undefined ? { modelContextWindow: contextWindow } : {}),
    })
  },

  setByokActive: (active: boolean) => {
    set({ byokActive: active })
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
      tasks: [],
      modelName: null,
      modelProvider: null,
      thinkingMode: null,
      modelContextWindow: null,
      byokActive: false,
      poolConcurrencyConflictsAvoided: 0,
    })
  },
}))
