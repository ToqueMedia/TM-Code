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

  /** Create a new run. Returns the runId, or null if the concurrent limit is reached. */
  startRun: (
    def: SubAgentDefinition,
    prompt: string,
    description: string,
    parentMessageId?: string,
    ownerTaskId?: string,
  ) => { runId: string; completionPromise: Promise<void> } | null

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

  /** Abort os sub-agents de UMA tarefa paralela parada/terminada (cascade). */
  abortByOwner: (ownerTaskId: string) => void

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

// ── Coalescência de tool-events (task #14, "tremeliques" do chat) ──────────
// addToolCall/updateToolCall chegam a vários por segundo POR sub-agent, e até
// 4 correm em paralelo. Cada set() troca o Map e notifica TODOS os
// subscritores React (cards de equipa, barras de estado) — por EVENTO isso
// dava re-render Chakra + repin de scroll do stick-to-bottom várias vezes por
// segundo enquanto o agente principal só esperava: o chat "tremia". As duas
// mutações de alta frequência acumulam aqui e aplicam-se numa ÚNICA troca de
// Map a cada FLUSH_MS (imperceptível num feed vivo). Tudo o que precisa de
// estado completo — ciclo de vida (finalize/error/timeout/abort/clear) e
// leituras via get() (getRunSummaries do check_team) — faz flush síncrono
// primeiro, por isso nenhum caminho de dados vê estado atrasado.
const FLUSH_MS = 150

type PendingToolCallOp =
  | { kind: 'add'; runId: string; summary: SubAgentToolCallSummary }
  | { kind: 'update'; runId: string; callId: string; update: Partial<SubAgentToolCallSummary> }

let pendingToolCallOps: PendingToolCallOp[] = []
let toolCallFlushTimer: ReturnType<typeof setTimeout> | null = null

export const useSubAgentStore = create<SubAgentStoreState>((set, get) => {
  const flushToolCallOps = () => {
    if (toolCallFlushTimer) {
      clearTimeout(toolCallFlushTimer)
      toolCallFlushTimer = null
    }
    if (pendingToolCallOps.length === 0) return
    const ops = pendingToolCallOps
    pendingToolCallOps = []
    set((state) => {
      const next = new Map(state.runs)
      for (const op of ops) {
        const run = next.get(op.runId)
        if (!run) continue
        if (op.kind === 'add') {
          next.set(op.runId, { ...run, toolCalls: [...run.toolCalls, op.summary] })
        } else {
          next.set(op.runId, {
            ...run,
            toolCalls: run.toolCalls.map(tc =>
              tc.callId === op.callId ? { ...tc, ...op.update } : tc
            ),
          })
        }
      }
      return { runs: next }
    })
  }

  const scheduleToolCallFlush = () => {
    if (!toolCallFlushTimer) {
      toolCallFlushTimer = setTimeout(flushToolCallOps, FLUSH_MS)
    }
  }

  return {
  runs: new Map(),

  startRun: (def, prompt, description, parentMessageId, ownerTaskId) => {
    // Atomic limit check — prevents TOCTOU race when multiple task()
    // calls run in parallel (concurrencySafe).
    const MAX_CONCURRENT_SUBAGENTS = 4
    const runningCount = Array.from(get().runs.values()).filter(r => r.status === 'running').length
    if (runningCount >= MAX_CONCURRENT_SUBAGENTS) {
      return null
    }

    const runId = `subagent-${nextRunId++}`

    // Create a promise that resolves when finalizeRun/errorRun/timeoutRun/abortRun is called
    let resolveCompletion: () => void
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })

    const run: SubAgentRun = {
      id: runId,
      parentMessageId,
      ...(ownerTaskId ? { ownerTaskId } : {}),
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
    pendingToolCallOps.push({ kind: 'add', runId, summary })
    scheduleToolCallFlush()
  },

  updateToolCall: (runId, callId, update) => {
    pendingToolCallOps.push({ kind: 'update', runId, callId, update })
    scheduleToolCallFlush()
  },

  finalizeRun: (runId, finalText, tokenUsage) => {
    flushToolCallOps()
    set((state) => {
      const run = state.runs.get(runId)
      if (!run || run.status !== 'running') return state
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
    flushToolCallOps()
    set((state) => {
      const run = state.runs.get(runId)
      if (!run || run.status !== 'running') return state
      const next = new Map(state.runs)
      next.set(runId, { ...run, status: 'error', errorText, endedAt: Date.now() })
      return { runs: next }
    })
    get().runs.get(runId)?._resolveCompletion()
  },

  timeoutRun: (runId, partialText) => {
    flushToolCallOps()
    set((state) => {
      const run = state.runs.get(runId)
      if (!run || run.status !== 'running') return state
      const next = new Map(state.runs)
      next.set(runId, { ...run, status: 'timeout', finalText: partialText, endedAt: Date.now() })
      return { runs: next }
    })
    get().runs.get(runId)?._resolveCompletion()
  },

  abortRun: (runId) => {
    flushToolCallOps()
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
    flushToolCallOps()
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

  abortByOwner: (ownerTaskId) => {
    flushToolCallOps()
    const { runs } = get()
    for (const [, run] of runs) {
      if (run.ownerTaskId === ownerTaskId && run.status === 'running') {
        run.abortController.abort()
        run._resolveCompletion()
      }
    }
    set((state) => {
      const next = new Map<string, SubAgentRun>()
      for (const [id, run] of state.runs) {
        if (run.ownerTaskId === ownerTaskId && run.status === 'running') {
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
    flushToolCallOps()
    const summaries: SubAgentRunSummary[] = []
    for (const run of get().runs.values()) {
      summaries.push({
        id: run.id,
        ...(run.ownerTaskId ? { ownerTaskId: run.ownerTaskId } : {}),
        agentType: run.definition.agentType,
        description: run.description,
        status: run.status,
        duration: (run.endedAt ?? Date.now()) - run.startedAt,
        toolCallCount: run.toolCalls.length,
        finalText: run.finalText,
        errorText: run.errorText,
        tokenUsage: run.tokenUsage,
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
    if (promises.length === 0) return
    // Race against a 5.5-minute safety timeout to prevent blocking forever
    // if a sub-agent crashes silently without resolving its promise.
    // Slightly exceeds the Verify agent's maxWallClockMs (5 min) to avoid
    // premature timeout when sub-agents are near their wall-clock limit.
    const TIMEOUT_MS = 330_000
    await Promise.race([
      Promise.all(promises),
      new Promise<void>(resolve => setTimeout(resolve, TIMEOUT_MS)),
    ])
  },

  clearCompleted: () => {
    flushToolCallOps()
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
    // Descarta pendentes — os runs vão todos embora de qualquer forma.
    pendingToolCallOps = []
    if (toolCallFlushTimer) {
      clearTimeout(toolCallFlushTimer)
      toolCallFlushTimer = null
    }
    // Abort any running before clearing
    for (const run of get().runs.values()) {
      if (run.status === 'running') {
        run.abortController.abort()
        run._resolveCompletion()
      }
    }
    set({ runs: new Map() })
  },
  }
})
