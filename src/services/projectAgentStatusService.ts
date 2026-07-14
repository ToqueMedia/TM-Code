/**
 * Per-project agent-run status, shared ACROSS WINDOWS via disk.
 *
 * Each TM Code window is an independent OS process (lib.rs
 * `open_new_instance`), so Zustand state cannot tell window B that window A's
 * agent is still working. This module is the WRITER side: it watches the
 * process-local agentStore/projectStore and mirrors the run state into the
 * project's app-managed state dir (`agent-status.json`, via the
 * `set_project_agent_status` command). The READER side is
 * useProjectAgentStatuses, which polls `get_project_agent_statuses` to render
 * the badges in the recents lists (Welcome sidebar + titlebar project menu).
 *
 * Liveness contract:
 *  - `running` is only trustworthy while the writer heartbeats
 *    (HEARTBEAT_MS). Readers discard `running` entries older than STALE_MS —
 *    that means the writing process crashed or was killed.
 *  - `done`/`error` have NO timeout. They persist until the user
 *    "acknowledges" them: focusing the window that owns the project, keeping
 *    it focused for ATTENDED_CLEAR_MS after the run ends (they watched it
 *    finish), or re-opening the project. Acknowledgement writes `idle`.
 *  - A gracefully closed window removes the file from Rust
 *    (WindowEvent::Destroyed → clear_project_agent_status).
 */

import { invoke } from '@/utils/invokeMetrics'
import { useAgentStore } from '@/stores/agentStore'
import { useProjectStore } from '@/stores/projectStore'
import { useChatStore } from '@/stores/chatStore'
import { logger } from '@/utils/logger'
import type { AgentStatus } from '@/types/agent'

export type ProjectAgentRunState = 'running' | 'done' | 'error' | 'idle'

/** Shape persisted by Rust (`ProjectAgentStatus`, camelCase-serialized). */
export interface ProjectAgentStatus {
  state: ProjectAgentRunState
  label?: string | null
  /** Descrição escrita pelo user na sessão — tooltip da row nas outras janelas. */
  description?: string | null
  updatedAt: number
  /**
   * Epoch ms when the run started. Set on the first `running` write and
   * preserved by heartbeats so other windows can show "a trabalhar · 12m".
   * Optional for files written before this field existed.
   */
  startedAt?: number | null
  pid: number
}

export const PROJECT_AGENT_STATUS_HEARTBEAT_MS = 30_000
/** Readers treat a `running` older than this as a crashed writer. */
export const PROJECT_AGENT_STATUS_STALE_MS = 90_000
/**
 * How long after a run ends the owning window waits before auto-clearing the
 * `done`/`error` badge — but only if the window is focused (the user was
 * watching the run finish, so other windows don't need a lingering badge).
 * An UNfocused window leaves the badge up until the user comes back.
 */
const ATTENDED_CLEAR_MS = 10_000

const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'awaiting_response',
  'reasoning',
  'generating',
  'applying',
  'compressing',
])

let started = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let attendedClearTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Project path the current `running` was written for. Captured at run start —
 * `currentProject` can already point at the NEXT project by the time the
 * cancelled run's status flips (project switch cancels the run first).
 */
let runningPath: string | null = null
let runningLabel: string | null = null
let runningDescription: string | null = null
/** Epoch ms of the current run's first `running` write — preserved on heartbeats. */
let runningStartedAt: number | null = null
/** Last terminal (`done`/`error`) write — cleared on user acknowledgement. */
let terminalWrite: { path: string; state: 'done' | 'error' } | null = null
/**
 * Set by the budget-stop watcher right before it aborts the run: the coming
 * busy→not-busy transition is an "out of credits" interruption, not a user
 * cancel — badge it `error` with this label instead of silently going idle,
 * so OTHER windows see WHY their sibling project stopped.
 */
let budgetStopLabel: string | null = null

export function markNextStopAsBudgetStop(label: string): void {
  budgetStopLabel = label
}

/**
 * Escritas SERIALIZADAS: heartbeat (setInterval) e escritas de transição são
 * invokes async concorrentes — sem a cadeia, um "running" atrasado podia
 * vencer o rename ao "done" e deixar um badge vivo-mentiroso até ao corte de
 * staleness (90s) nas outras janelas. A cadeia garante que a ordem de
 * chegada ao Rust é a ordem em que decidimos escrever.
 *
 * `onlyIfOwn`: escreve apenas se o ficheiro actual pertence a ESTE processo
 * (pid) — usado nos clears para nunca apagar o badge verdadeiro de OUTRA
 * janela com o mesmo projecto aberto.
 */
let writeChain: Promise<void> = Promise.resolve()

function writeStatus(
  projectPath: string,
  state: ProjectAgentRunState,
  label?: string | null,
  opts?: { onlyIfOwn?: boolean; startedAt?: number | null; description?: string | null },
): void {
  writeChain = writeChain.then(() =>
    invoke('set_project_agent_status', {
      projectPath,
      state,
      label: label ?? null,
      onlyIfOwn: opts?.onlyIfOwn === true,
      // Only attach startedAt on `running` — terminal/idle clears drop it.
      startedAt: state === 'running' ? (opts?.startedAt ?? null) : null,
      description: opts?.description ?? null,
    }).catch(err => {
      logger.warn('agent', 'set_project_agent_status failed:', err)
    }) as Promise<void>,
  )
}

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (runningPath) {
      // Re-lê os metadados da sessão a cada beat: se o user renomear a
      // tarefa ou editar a descrição A MEIO do run, as outras janelas veem
      // a edição no próximo heartbeat (≤30s) em vez de só no próximo run.
      // O título continua estável por natureza — session.name não deriva.
      const meta = extractTaskMeta()
      if (meta.label) runningLabel = meta.label
      runningDescription = meta.description
      writeStatus(runningPath, 'running', runningLabel, {
        startedAt: runningStartedAt,
        description: runningDescription,
      })
    }
  }, PROJECT_AGENT_STATUS_HEARTBEAT_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function cancelAttendedClear(): void {
  if (attendedClearTimer) {
    clearTimeout(attendedClearTimer)
    attendedClearTimer = null
  }
}

function scheduleAttendedClear(): void {
  cancelAttendedClear()
  attendedClearTimer = setTimeout(() => {
    attendedClearTimer = null
    if (typeof document !== 'undefined' && document.hasFocus()) {
      acknowledgeTerminalStatus()
    }
  }, ATTENDED_CLEAR_MS)
}

/**
 * User saw the finished run (window focus / project open) — drop the
 * `done`/`error` badge so other windows stop announcing it.
 */
export function acknowledgeTerminalStatus(): void {
  if (!terminalWrite) return
  const currentPath = useProjectStore.getState().currentProject?.path
  if (!currentPath || currentPath !== terminalWrite.path) return
  if (BUSY_STATUSES.has(useAgentStore.getState().status)) return
  writeStatus(terminalWrite.path, 'idle', null, { onlyIfOwn: true })
  terminalWrite = null
}

function truncateLabel(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean
}

/**
 * Título + descrição da tarefa para a árvore/badges nas outras janelas.
 *
 * REGRA (pedido do user 2026-07-14): o título é SEMPRE o primeiro texto da
 * primeira mensagem do user — nunca deriva com mensagens posteriores. A
 * fonte é session.name (fixado uma vez em addMessage com a primeira
 * mensagem, ou editado manualmente pelo user via updateSessionMeta); o
 * fallback para sessões legadas sem name percorre as mensagens do INÍCIO
 * (a versão antiga percorria de trás para a frente e apanhava a última
 * mensagem — steering/segunda tarefa reescrevia o título a cada run).
 * A descrição é exclusivamente escrita pelo user.
 */
function extractTaskMeta(): { label: string | null; description: string | null } {
  try {
    const session = useChatStore.getState().getActiveSession()
    if (!session) return { label: null, description: null }
    const description = session.description?.trim() || null
    if (session.name?.trim()) {
      return { label: truncateLabel(session.name), description }
    }
    for (const m of session.messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        const text = m.content.replace(/\s+/g, ' ').trim()
        if (!text) continue
        return { label: truncateLabel(text), description }
      }
    }
    return { label: null, description }
  } catch {
    /* non-critical */
  }
  return { label: null, description: null }
}

function onAgentStatusChange(status: AgentStatus, prevStatus: AgentStatus): void {
  const wasBusy = BUSY_STATUSES.has(prevStatus)
  const isBusy = BUSY_STATUSES.has(status)

  if (!wasBusy && isBusy) {
    const path = useProjectStore.getState().currentProject?.path
    if (!path) return
    runningPath = path
    const meta = extractTaskMeta()
    runningLabel = meta.label
    runningDescription = meta.description
    runningStartedAt = Date.now()
    terminalWrite = null
    budgetStopLabel = null
    cancelAttendedClear()
    writeStatus(path, 'running', runningLabel, {
      startedAt: runningStartedAt,
      description: runningDescription,
    })
    startHeartbeat()
    return
  }

  if (wasBusy && !isBusy) {
    stopHeartbeat()
    const path = runningPath
    runningPath = null
    runningStartedAt = null
    if (!path) {
      budgetStopLabel = null
      return
    }
    if (budgetStopLabel) {
      // Budget-stop interruption. Checked FIRST and regardless of the final
      // status value — depending on where the abort lands, the run can end
      // as 'cancelled', 'error' or plain 'idle', and all of them mean the
      // same thing here: stopped because credits ran out.
      terminalWrite = { path, state: 'error' }
      writeStatus(path, 'error', budgetStopLabel, { description: runningDescription })
      scheduleAttendedClear()
    } else if (status === 'error') {
      terminalWrite = { path, state: 'error' }
      writeStatus(path, 'error', runningLabel, { description: runningDescription })
      scheduleAttendedClear()
    } else if (status === 'cancelled') {
      // Explicit user stop — attended by definition, no badge to keep.
      terminalWrite = null
      writeStatus(path, 'idle', null, { onlyIfOwn: true })
    } else {
      terminalWrite = { path, state: 'done' }
      writeStatus(path, 'done', runningLabel, { description: runningDescription })
      scheduleAttendedClear()
    }
    budgetStopLabel = null
    runningLabel = null
    runningDescription = null
  }
}

/**
 * Opening a project acknowledges any lingering `done`/`error` badge and
 * clears a stale `running` left by a crashed previous process. A FRESH
 * `running` from another live window is left alone — its heartbeat is the
 * proof of life, and overwriting it would blank a truthful badge.
 */
async function clearStaleStatusOnOpen(path: string): Promise<void> {
  try {
    const map = await invoke<Record<string, ProjectAgentStatus>>(
      'get_project_agent_statuses',
      { projectPaths: [path] },
    )
    const status = map?.[path]
    if (!status || status.state === 'idle') return
    const freshRunning =
      status.state === 'running' &&
      Date.now() - status.updatedAt <= PROJECT_AGENT_STATUS_STALE_MS
    if (!freshRunning) writeStatus(path, 'idle')
  } catch {
    /* best-effort — Tauri absent in tests */
  }
}

function onProjectChange(
  newPath: string | null,
  prevPath: string | null,
): void {
  if (prevPath === newPath) return
  if (prevPath) {
    // Leaving a project (switch/close). The run was already cancelled by
    // projectStore's guard — make sure no badge from THIS window survives.
    // onlyIfOwn: another window may have the SAME project open and running;
    // its truthful badge must not be stamped over by our exit.
    stopHeartbeat()
    cancelAttendedClear()
    if (runningPath === prevPath) {
      runningPath = null
      runningStartedAt = null
      runningDescription = null
    }
    if (terminalWrite?.path === prevPath) terminalWrite = null
    writeStatus(prevPath, 'idle', null, { onlyIfOwn: true })
  }
  if (newPath) {
    void clearStaleStatusOnOpen(newPath)
  }
}

/** Idempotent — call once at app mount (App.tsx). */
export function initProjectAgentStatusWriter(): void {
  if (started) return
  started = true

  useAgentStore.subscribe((state, prev) => {
    if (state.status !== prev.status) {
      onAgentStatusChange(state.status, prev.status)
    }
  })

  useProjectStore.subscribe((state, prev) => {
    onProjectChange(
      state.currentProject?.path ?? null,
      prev.currentProject?.path ?? null,
    )
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', acknowledgeTerminalStatus)
  }
}
