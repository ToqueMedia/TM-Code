import { create } from 'zustand'

export type DeployPhase = 'idle' | 'in_progress' | 'success' | 'error'

export interface DeployStep {
  step: number
  totalSteps: number
  stepName: string
  status: 'in_progress' | 'complete'
  detail?: string
}

export interface DeployRecord {
  projectId: string
  phase: DeployPhase
  /** Current step the orchestrator is on. Reset on new deploy. */
  currentStep: DeployStep | null
  /** All steps observed in this deploy, in order. */
  history: DeployStep[]
  /** Non-fatal warnings emitted by the orchestrator (migration warnings, etc.) */
  warnings: string[]
  /** Final URL after a successful deploy. */
  serviceUrl: string | null
  /** Provider string the backend reported (`cloudflare-workers` | `cloudflare+r2`). */
  provider: string | null
  /** D1 database id when the project shipped a backend. */
  databaseId: string | null
  /** Last error message if phase === 'error'. */
  error: string | null
  /** Epoch ms when this deploy started. */
  startedAt: number | null
  /** Epoch ms when this deploy reached a terminal state. */
  finishedAt: number | null
  /** Monotonically incremented on each startDeploy. Long-running tasks (the
   *  container-build poll loop) capture this at start and check it before
   *  every tick — a mismatch means a newer attempt superseded them, so they
   *  bail without writing further updates. Defends against zombie polls
   *  after the user re-deploys the same projectId. */
  attemptId: number
}

interface DeployState {
  records: Map<string, DeployRecord>
}

interface DeployActions {
  startDeploy: (projectId: string) => void
  updateProgress: (projectId: string, step: DeployStep) => void
  addWarning: (projectId: string, message: string) => void
  completeDeploy: (
    projectId: string,
    result: { serviceUrl: string; provider: string; databaseId: string | null },
  ) => void
  failDeploy: (projectId: string, error: string) => void
  /** Selector helper — returns a stable record for the project (or a fresh blank one). */
  getRecord: (projectId: string) => DeployRecord
  clear: (projectId: string) => void
}

function blank(projectId: string): DeployRecord {
  return {
    projectId,
    phase: 'idle',
    currentStep: null,
    history: [],
    warnings: [],
    serviceUrl: null,
    provider: null,
    databaseId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    attemptId: 0,
  }
}

export const useDeployStore = create<DeployState & DeployActions>((set, get) => ({
  records: new Map(),

  startDeploy: (projectId) => {
    set((state) => {
      const next = new Map(state.records)
      const previous = next.get(projectId)
      next.set(projectId, {
        ...blank(projectId),
        phase: 'in_progress',
        startedAt: Date.now(),
        // Bump the attempt counter so any in-flight polls from a prior
        // deploy of this same projectId see a mismatch and exit cleanly.
        attemptId: (previous?.attemptId ?? 0) + 1,
      })
      return { records: next }
    })
  },

  updateProgress: (projectId, step) => {
    set((state) => {
      const next = new Map(state.records)
      const current = next.get(projectId) ?? blank(projectId)
      // Replace the last history entry if it's the same step toggling status,
      // otherwise append a new one.
      const last = current.history[current.history.length - 1]
      let history: DeployStep[]
      if (last && last.step === step.step && last.stepName === step.stepName) {
        history = [...current.history.slice(0, -1), step]
      } else {
        history = [...current.history, step]
      }
      next.set(projectId, {
        ...current,
        phase: 'in_progress',
        currentStep: step,
        history,
      })
      return { records: next }
    })
  },

  addWarning: (projectId, message) => {
    set((state) => {
      const next = new Map(state.records)
      const current = next.get(projectId) ?? blank(projectId)
      next.set(projectId, {
        ...current,
        warnings: [...current.warnings, message],
      })
      return { records: next }
    })
  },

  completeDeploy: (projectId, result) => {
    set((state) => {
      const next = new Map(state.records)
      const current = next.get(projectId) ?? blank(projectId)
      next.set(projectId, {
        ...current,
        phase: 'success',
        serviceUrl: result.serviceUrl,
        provider: result.provider,
        databaseId: result.databaseId,
        finishedAt: Date.now(),
      })
      return { records: next }
    })
  },

  failDeploy: (projectId, error) => {
    set((state) => {
      const next = new Map(state.records)
      const current = next.get(projectId) ?? blank(projectId)
      next.set(projectId, {
        ...current,
        phase: 'error',
        error,
        finishedAt: Date.now(),
      })
      return { records: next }
    })
  },

  getRecord: (projectId) => {
    return get().records.get(projectId) ?? blank(projectId)
  },

  clear: (projectId) => {
    set((state) => {
      const next = new Map(state.records)
      next.delete(projectId)
      return { records: next }
    })
  },
}))
