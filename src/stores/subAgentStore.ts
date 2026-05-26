/**
 * Zustand store for sub-agent runs.
 *
 * Replaces backgroundAgentStore + subAgentVisibility. Sub-agent activity
 * lives here — NOT in chatStore. The SubAgentCard UI subscribes to this
 * store to render team activity (collapsed by default).
 */

import { create } from 'zustand'
import type { SubAgentRun, SubAgentToolCallSummary, SubAgentDefinition, SubAgentRunSummary } from '../services/agent/subAgents/types'

interface SubAgentStoreState {
  runs: Map<string, SubAgentRun>

  // ── Actions ──────────────────────────────────────────────────────────

  /** Create a new run. Returns the runId. */
  startRun: (
    def: SubAgentDefinition,
    prompt: string,
    description: string,
    parentMessageId: string,
  ) => { runId: string; completionPromise: Promise<void> }

  /** Record a new tool call in the run's toolCalls list. */
  addToolCall: (runId: string, summary: SubAgentToolCallSummary) => void

  /** Update an existing tool call's status/result. */
  updateToolCall: (runId: string, callId: string, update: Partial<SubAgentToolCallSummary>) => void

  /** Mark a run as completed with its final text. */
  finalizeRun: (runId: string, finalText: string, tokenUsage: { input: number; output: number }) => void

  /** Mark a run as errored. */
  errorRun: (runId: string, errorText: string) => void

  /** Mark a run as timed out. */
  timeoutRun: (runId: string, partialText: string) => void

  /** Abort a single run. */
  abortRun: (runId: string) => void

  /** Abort ALL running sub-agents (cascade from parent Stop). */
  abortAll: () => void

  /** Get count of currently running sub-agents. */
  getPendingCount: () => number

  /** Get compact summaries of all runs (for check_team tool). */
  getRunSummaries: () => SubAgentRunSummary[]

  /** Await all pending completion promises. Used by check_team(). */
  awaitAllPending: () => Promise<void>

  /** Clear completed/errored/aborted runs. */
  clearCompleted: () => void

  /** Clear everything. */
  clearAll: () => void
}

let nextRunId = 1

export const useSubAgentStore = create<SubAgentStoreState>((set, get) => ({
  runs: new Map(),

  startRun: (def, prompt, description, parentMessageId) => {
    const runId = `subagent-${nextRunId++}`

    // Create a promise that resolves when finalizeRun/errorRun/timeoutRun/abortRun is called
    let resolveCompletion: () => void
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })

    const run: SubAgentRun = {
      id: runId,
      parentMessageId,
      definition: def,
      prompt,
      description,
      status: 'running',
      toolCalls: [],
      finalText: '',
      startedAt: Date.now(),
      tokenUsage: { input: 0, output: 0 },
      abortController: new AbortController(),
      completionPromise,
      _resolveCompletion: resolveCompletion!,
    }

    set((state) => {
      const next = new Map(state.runs)
      next.set(runId, run)
      return { runs: next }
    })

    return { runId, completionPromise }
  },

  addToolCall: (runId, summary) => {
    set((state) => {
      const run = state.runs.get(runId)
      if (!run) return state
      const next = new Map(state.runs)
      next.set(runId, { ...run, toolCalls: [...run.toolCalls, summary] })
      return { runs: next }
    })
  },

  updateToolCall: (runId, callId, update) => {
    set((state) => {
      const run = state.runs.get(runId)
      if (!run) return state
      const next = new Map(state.runs)
      next.set(runId, {
        ...run,
        toolCalls: run.toolCalls.map(tc =>
          tc.callId === callId ? { ...tc, ...update } : tc
        ),
      })
      return { runs: next }
    })
  },

  finalizeRun: (runId, finalText, tokenUsage) => {
    set((state) => {
      const run = state.runs.get(runId)
      if (!run) return state
      const next = new Map(state.runs)
      next.set(runId, {
        ...run,
        status: 'completed',
        finalText,
        endedAt: Date.now(),
        tokenUsage: {
          input: run.tokenUsage.input + tokenUsage.input,
          output: run.tokenUsage.output + tokenUsage.output,
        },
      })
      return { runs: next }
    })
    // Resolve the completion promise so check_team() unblocks
    get().runs.get(runId)?._resolveCompletion()
  },

  errorRun: (runId, errorText) => {
    set((state) => {
      const run = state.runs.get(runId)
      if (!run) return state
      const next = new Map(state.runs)
      next.set(runId, { ...run, status: 'error', errorText, endedAt: Date.now() })
      return { runs: next }
    })
    get().runs.get(runId)?._resolveCompletion()
  },

  timeoutRun: (runId, partialText) => {
    set((state) => {
      const run = state.runs.get(runId)
      if (!run) return state
      const next = new Map(state.runs)
      next.set(runId, { ...run, status: 'timeout', finalText: partialText, endedAt: Date.now() })
      return { runs: next }
    })
    get().runs.get(runId)?._resolveCompletion()
  },

  abortRun: (runId) => {
    const run = get().runs.get(runId)
    if (!run) return
    run.abortController.abort()
    set((state) => {
      const next = new Map(state.runs)
      next.set(runId, { ...run, status: 'aborted', endedAt: Date.now() })
      return { runs: next }
    })
    run._resolveCompletion()
  },

  abortAll: () => {
    const { runs } = get()
    for (const [_id, run] of runs) {
      if (run.status === 'running') {
        run.abortController.abort()
        run._resolveCompletion()
      }
    }
    set((state) => {
      const next = new Map<string, SubAgentRun>()
      for (const [id, run] of state.runs) {
        if (run.status === 'running') {
          next.set(id, { ...run, status: 'aborted', endedAt: Date.now() })
        } else {
          next.set(id, run)
        }
      }
      return { runs: next }
    })
  },

  getPendingCount: () => {
    let count = 0
    for (const run of get().runs.values()) {
      if (run.status === 'running') count++
    }
    return count
  },

  getRunSummaries: () => {
    const summaries: SubAgentRunSummary[] = []
    for (const run of get().runs.values()) {
      summaries.push({
        id: run.id,
        agentType: run.definition.agentType,
        description: run.description,
        status: run.status,
        duration: (run.endedAt ?? Date.now()) - run.startedAt,
        toolCallCount: run.toolCalls.length,
        finalText: run.finalText,
        errorText: run.errorText,
      })
    }
    return summaries
  },

  awaitAllPending: async () => {
    const promises: Promise<void>[] = []
    for (const run of get().runs.values()) {
      if (run.status === 'running') {
        promises.push(run.completionPromise)
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises)
    }
  },

  clearCompleted: () => {
    set((state) => {
      const next = new Map<string, SubAgentRun>()
      for (const [id, run] of state.runs) {
        if (run.status === 'running') {
          next.set(id, run)
        }
      }
      return { runs: next }
    })
  },

  clearAll: () => {
    // Abort any running before clearing
    for (const run of get().runs.values()) {
      if (run.status === 'running') {
        run.abortController.abort()
        run._resolveCompletion()
      }
    }
    set({ runs: new Map() })
  },
}))
