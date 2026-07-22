/**
 * Store for USER-initiated parallel task agents (v1.0.1 "multi-agent").
 *
 * Distinct from subAgentStore (which holds the MAIN agent's read-only delegate
 * sub-agents). These are co-equal, WRITABLE top-level tasks the user fires from
 * the composer: up to `MAX_CONCURRENT_TASKS` run at once, the rest wait in a FIFO
 * queue and are promoted as slots free. Each run publishes its live tool calls +
 * status here; the ParallelTasksDock renders them as cards. It never touches
 * chatStore streaming, so it can't collide with the main interactive agent.
 */

import { create } from 'zustand'
import type { SubAgentToolCallSummary } from '../services/agent/subAgents/types'

/**
 * Parar uma tarefa leva consigo os pedidos interativos DELA (permissão,
 * pergunta, credenciais) — resolve as promises penduradas para o tool
 * desbloquear e o diálogo/card não ficar a exibir um agente morto.
 * Dinâmico para não arrastar os stores pesados para quem importa este.
 */
function cancelTaskInteractions(taskId: string): void {
  void Promise.all([
    import('./permissionStore'),
    import('./askUserQuestionStore'),
    import('./credentialRequestStore'),
  ]).then(([perm, ask, cred]) => {
    perm.usePermissionStore.getState().cancelByOrigin(taskId)
    ask.useAskUserQuestionStore.getState().cancelByOrigin(taskId)
    cred.useCredentialRequestStore.getState().cancelByOrigin(taskId)
  }).catch(() => { /* best-effort */ })
}

/**
 * Abort de tarefa ainda EM FILA: o runner nunca arrancou, logo o finally que
 * stampa/persiste o estado terminal nunca corre — sem isto, a sessão ficava
 * 'running'-órfã (ou nem existia) e o chat "desaparecia" após reload. Import
 * dinâmico como cancelTaskInteractions (evita ciclo com o chatStore).
 */
function stampQueuedAbort(sessionId: string | undefined): void {
  if (!sessionId) return
  void import('./chatStore').then(({ useChatStore }) => {
    useChatStore.getState().setSessionTaskStatus(sessionId, 'aborted')
  }).catch(() => { /* best-effort */ })
}

export const MAX_CONCURRENT_TASKS = 4

export type ParallelTaskStatus = 'queued' | 'running' | 'completed' | 'error' | 'aborted'

export interface ParallelTaskRun {
  id: string
  prompt: string
  /** Short label for the card (derived from the prompt). */
  description: string
  /**
   * Chat session backing this task (created non-active by the manager).
   * Clicking the task in the ProjectMenu opens THIS session — the runner
   * writes the prompt at launch and the result/error at the end.
   */
  sessionId?: string
  /**
   * Projecto a que a tarefa pertence. As rows da sidebar/ProjectMenu
   * renderizam para TODOS os projetos (cross-window) — sem este carimbo,
   * cada instância do hook incluía TODAS as runs vivas do processo e a
   * mesma tarefa aparecia debaixo de todos os projetos (feedback do user,
   * 2026-07-16).
   */
  projectPath?: string
  /** Run de CONTINUAÇÃO: corre SOBRE uma sessão existente (com histórico) em
   *  vez de nascer com sessão própria — "o agente da sessão que estás a ver"
   *  quando o run interativo está ocupado noutra (doutrina sem-deus). */
  continuation?: boolean
  /** Fase 5: worktree isolado onde esta tarefa trabalha (opt-in via
   *  Definições). Preenchido pelo runner após criação bem-sucedida. */
  worktree?: { path: string; branch: string }
  /** Fase 6 (inbox): o developer já viu o resultado desta tarefa terminada?
   *  false → item "terminou/falhou" no inbox de atenção da titlebar. */
  resultSeen?: boolean
  /**
   * Fase 6b (quadro de claims): caminhos (relativos à raiz) que ESTA tarefa
   * modificou. É o registo que impõe a regra de propriedade — outra tarefa
   * que tente mexer num destes ficheiros é bloqueada e reporta-o no fim.
   */
  modifiedFiles?: string[]
  status: ParallelTaskStatus
  toolCalls: SubAgentToolCallSummary[]
  finalText: string
  errorText?: string
  createdAt: number
  startedAt?: number
  endedAt?: number
  tokenUsage: { input: number; output: number }
  abortController: AbortController
  /** Mensagens do composer à espera do próximo turn boundary DESTA tarefa
   *  (Fase 3: com a sessão da tarefa em foco, o composer steera-a). */
  steerQueue: string[]
}

interface ParallelTaskState {
  runs: Map<string, ParallelTaskRun>

  /** Enqueue a new task (status 'queued'). Returns its id. Promotion to
   *  'running' is the manager's job (markRunning) once a slot is free. */
  createQueued: (prompt: string, description: string, sessionId?: string, projectPath?: string, opts?: { continuation?: boolean }) => string
  /** Flip a queued task to running (called by the manager when a slot frees). */
  markRunning: (id: string) => void
  addToolCall: (id: string, tc: SubAgentToolCallSummary) => void
  updateToolCall: (id: string, callId: string, patch: Partial<SubAgentToolCallSummary>) => void
  finalize: (id: string, finalText: string, usage: { input: number; output: number }) => void
  error: (id: string, errorText: string) => void
  /** Regista o worktree isolado desta tarefa (Fase 5). */
  setWorktree: (id: string, worktree: { path: string; branch: string }) => void
  /** Marca o resultado como visto (abrir o chat da tarefa / estar a vê-lo). */
  markResultSeen: (id: string) => void
  /** Regista um ficheiro modificado por esta tarefa (claim de propriedade). */
  addModifiedFile: (id: string, relPath: string) => void
  /** FECHO pelo developer: remove a entrada viva de uma tarefa TERMINADA
   *  (a sessão em disco é apagada pelo caller). Tarefas só desaparecem assim. */
  removeClosed: (id: string) => void
  /** Enfileira uma orientação do user para esta tarefa (composer em foco). */
  enqueueSteer: (id: string, text: string) => void
  /** Drena (e limpa) a fila de steering — chamado pelo runner por turno. */
  drainSteer: (id: string) => string[]
  /** Abort one task (queued or running). */
  abort: (id: string) => void
  /** Abort everything (queued + running). */
  abortAll: () => void
  /** Drop finished (completed/error/aborted) runs from the map. */
  clearFinished: () => void

  // ── Selectors (read-only helpers) ──
  runningCount: () => number
  /** id of the oldest queued task, or null. */
  nextQueuedId: () => string | null
}

let nextId = 1

export const useParallelTaskStore = create<ParallelTaskState>((set, get) => ({
  runs: new Map(),

  createQueued: (prompt, description, sessionId, projectPath, opts) => {
    const id = `task-${nextId++}`
    const run: ParallelTaskRun = {
      id,
      prompt,
      description,
      sessionId,
      projectPath,
      continuation: opts?.continuation === true,
      status: 'queued',
      toolCalls: [],
      finalText: '',
      createdAt: Date.now(),
      tokenUsage: { input: 0, output: 0 },
      abortController: new AbortController(),
      steerQueue: [],
    }
    set((s) => {
      const runs = new Map(s.runs)
      runs.set(id, run)
      return { runs }
    })
    return id
  },

  markRunning: (id) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run || run.status !== 'queued') return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, status: 'running', startedAt: Date.now() })
      return { runs }
    }),

  addToolCall: (id, tc) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, toolCalls: [...run.toolCalls, tc] })
      return { runs }
    }),

  updateToolCall: (id, callId, patch) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(id, {
        ...run,
        toolCalls: run.toolCalls.map((tc) => (tc.callId === callId ? { ...tc, ...patch } : tc)),
      })
      return { runs }
    }),

  finalize: (id, finalText, usage) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run || run.status !== 'running') return s
      const runs = new Map(s.runs)
      runs.set(id, {
        ...run,
        status: 'completed',
        finalText,
        endedAt: Date.now(),
        tokenUsage: {
          input: run.tokenUsage.input + usage.input,
          output: run.tokenUsage.output + usage.output,
        },
      })
      return { runs }
    }),

  error: (id, errorText) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run || (run.status !== 'running' && run.status !== 'queued')) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, status: 'error', errorText, endedAt: Date.now() })
      return { runs }
    }),

  addModifiedFile: (id, relPath) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run) return s
      const existing = run.modifiedFiles ?? []
      if (existing.includes(relPath)) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, modifiedFiles: [...existing, relPath] })
      return { runs }
    }),

  removeClosed: (id) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run || run.status === 'running' || run.status === 'queued') return s
      const runs = new Map(s.runs)
      runs.delete(id)
      return { runs }
    }),

  markResultSeen: (id) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run || run.resultSeen) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, resultSeen: true })
      return { runs }
    }),

  setWorktree: (id, worktree) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, worktree })
      return { runs }
    }),

  enqueueSteer: (id, text) =>
    set((s) => {
      const run = s.runs.get(id)
      if (!run || (run.status !== 'running' && run.status !== 'queued')) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run, steerQueue: [...run.steerQueue, text] })
      return { runs }
    }),

  drainSteer: (id) => {
    const run = get().runs.get(id)
    if (!run || run.steerQueue.length === 0) return []
    const drained = run.steerQueue
    set((s) => {
      const current = s.runs.get(id)
      if (!current) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...current, steerQueue: [] })
      return { runs }
    })
    return drained
  },

  abort: (id) => {
    const run = get().runs.get(id)
    if (!run) return
    if (run.status === 'running' || run.status === 'queued') {
      run.abortController.abort()
      cancelTaskInteractions(id)
      if (run.status === 'queued') stampQueuedAbort(run.sessionId)
    }
    set((s) => {
      const run2 = s.runs.get(id)
      if (!run2 || (run2.status !== 'running' && run2.status !== 'queued')) return s
      const runs = new Map(s.runs)
      runs.set(id, { ...run2, status: 'aborted', endedAt: Date.now() })
      return { runs }
    })
  },

  abortAll: () => {
    for (const run of get().runs.values()) {
      if (run.status === 'running' || run.status === 'queued') {
        run.abortController.abort()
        cancelTaskInteractions(run.id)
        if (run.status === 'queued') stampQueuedAbort(run.sessionId)
      }
    }
    set((s) => {
      const runs = new Map<string, ParallelTaskRun>()
      for (const [id, run] of s.runs) {
        if (run.status === 'running' || run.status === 'queued') {
          runs.set(id, { ...run, status: 'aborted', endedAt: Date.now() })
        } else {
          runs.set(id, run)
        }
      }
      return { runs }
    })
  },

  clearFinished: () =>
    set((s) => {
      const runs = new Map<string, ParallelTaskRun>()
      for (const [id, run] of s.runs) {
        if (run.status === 'running' || run.status === 'queued') runs.set(id, run)
      }
      return { runs }
    }),

  runningCount: () => {
    let n = 0
    for (const r of get().runs.values()) if (r.status === 'running') n++
    return n
  },

  nextQueuedId: () => {
    let oldest: ParallelTaskRun | null = null
    for (const r of get().runs.values()) {
      if (r.status === 'queued' && (!oldest || r.createdAt < oldest.createdAt)) oldest = r
    }
    return oldest?.id ?? null
  },
}))
