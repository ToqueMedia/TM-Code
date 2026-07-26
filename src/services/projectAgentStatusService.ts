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
 * Reader cadence: ~1.5s focused / 3s background (see hook constants).
 *
 * Liveness contract:
 *  - `running` is only trustworthy while the writer heartbeats
 *    (~3s focused / 30s background). Readers discard `running` older than
 *    STALE_MS — that means the writing process crashed or was killed.
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

/** Heartbeat when the window is in the background (CPU-light). */
export const PROJECT_AGENT_STATUS_HEARTBEAT_MS = 30_000
/**
 * Heartbeat when this window is focused — other windows see cross-window
 * status/stop lag of a few seconds instead of waiting up to 30s.
 * (ARCHITECTURE Current parallel model — multi-window polish.)
 */
export const PROJECT_AGENT_STATUS_HEARTBEAT_FOCUSED_MS = 3_000
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

/**
 * Write a cross-window agent badge for a BACKGROUND project-run (the parallel
 * runner). The single-slot main-run writer (`runningPath`) tracks only the
 * focused main run; a background run on ANOTHER project must drive its OWN badge
 * or the recents list shows it idle in every window (F2 MDI — "see each
 * project's progress"). Serialized through the same writeChain. `onlyIfOwn`
 * stays false — this process owns the run. One-agent-per-project guarantees the
 * background run's project never collides with the main writer's `runningPath`.
 */
export function writeProjectRunBadge(
  projectPath: string,
  state: ProjectAgentRunState,
  opts?: { label?: string | null; description?: string | null; startedAt?: number | null },
): void {
  const path = normalizeProjectPath(projectPath)
  if (!path) return
  // Never let a background project-run stamp the project the MAIN agent is
  // already badging — one agent per project; dual writers = dual "running"
  // lies in the recents list.
  if (state === 'running' && runningPath && runningPath === path) {
    return
  }
  writeStatus(path, state, opts?.label ?? null, {
    startedAt: opts?.startedAt ?? null,
    description: opts?.description ?? null,
  })
}

function heartbeatIntervalMs(): number {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      return PROJECT_AGENT_STATUS_HEARTBEAT_FOCUSED_MS
    }
  } catch { /* non-DOM tests */ }
  return PROJECT_AGENT_STATUS_HEARTBEAT_MS
}

function tickHeartbeat(): void {
  // Re-bind to the RUN's project each beat. setProjectContext / session
  // may be more accurate than the path captured at busy-start (wrong
  // recents badge when focus and run diverged — report 2026-07-24).
  const livePath = resolveMainBadgePath()
  if (livePath && runningPath && livePath !== runningPath) {
    writeStatus(runningPath, 'idle', null, { onlyIfOwn: true })
    runningPath = livePath
    runningStartedAt = runningStartedAt ?? Date.now()
  }
  if (!runningPath) return
  // Cross-window Stop from WelcomeSidebar (project-level disk flag).
  // Parallel runners consume the same flag on their own heartbeat; F3
  // guarantees one agent per project so only one owner is live here.
  const pathForStop = runningPath
  void import('./agent/parallelTasks/taskStopRequestService')
    .then(({ consumeProjectAgentStop }) => consumeProjectAgentStop(pathForStop))
    .then((stop) => {
      if (!stop) return
      // Unified stop reason (Pacote 3): user stopped from another window.
      try {
        const { useChatStore } = require('../stores/chatStore') as typeof import('../stores/chatStore')
        const { t } = require('../i18n') as typeof import('../i18n')
        useChatStore.getState().addSystemMessage(t('parallel.stoppedRemoteWindow'), 'info')
      } catch { /* chat optional */ }
      void import('./agent/stopAgentRun').then(({ stopAgentRun }) => {
        stopAgentRun()
      })
    })
    .catch(() => { /* best-effort */ })
  // Cross-window focus request: another window clicked this project and asked
  // us to come to the front (disk bus; residual OS-focus polish).
  void import('./projectWindowFocusService')
    .then(({ consumeFocusRequestIfAny }) => consumeFocusRequestIfAny(pathForStop))
    .catch(() => { /* best-effort */ })
  // Re-lê os metadados da sessão a cada beat: se o user renomear a
  // tarefa ou editar a descrição A MEIO do run, as outras janelas veem
  // a edição no próximo heartbeat (≤3s focused / ≤30s background).
  const meta = extractTaskMeta()
  if (meta.label) runningLabel = meta.label
  runningDescription = meta.description
  writeStatus(runningPath, 'running', runningLabel, {
    startedAt: runningStartedAt,
    description: runningDescription,
  })
}

/** Module-level re-arm so focus/visibility always use current runningPath. */
function rearmHeartbeat(): void {
  stopHeartbeat()
  // Never re-arm after the run ends (runningPath cleared) — focus/blur
  // listeners must not resurrect a dead heartbeat with a stale path.
  if (!runningPath) return
  heartbeatTimer = setInterval(tickHeartbeat, heartbeatIntervalMs())
}

function startHeartbeat(): void {
  rearmHeartbeat()
  // Re-arm on focus/visibility so we switch 3s ↔ 30s without a process restart.
  if (typeof document !== 'undefined' && !visibilityBound) {
    visibilityBound = true
    document.addEventListener('visibilitychange', rearmHeartbeat)
    window.addEventListener('focus', rearmHeartbeat)
    window.addEventListener('blur', rearmHeartbeat)
  }
}

let visibilityBound = false

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

function normalizeProjectPath(path: string | null | undefined): string | null {
  if (!path) return null
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || null
}

/**
 * Project the MAIN agent run is bound to for the cross-window badge.
 *
 * Priority (F2 multi-project — never trust focus alone):
 *  1. ToolExecutor project context (set by agentRunner before setStatus)
 *  2. streamingSessionId's session.projectPath (where the run writes)
 *  3. active session projectPath
 *  4. focused currentProject (last resort)
 *
 * Using only currentProject stamped the wrong recent when the developer had
 * switched projects or a previous bound context was still on the executor.
 */
function resolveMainBadgePath(): string | null {
  try {
    // Lazy require: toolExecutor is heavy; this module loads at app boot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ToolExecutor = require('./agent/toolExecutor').default as {
      getInstance: () => { getProjectContext: () => { projectPath: string } | null }
    }
    const ctx = ToolExecutor.getInstance().getProjectContext()
    const bound = normalizeProjectPath(ctx?.projectPath)
    if (bound) return bound
  } catch { /* tests / early boot */ }

  try {
    const chat = useChatStore.getState() as {
      streamingSessionId?: string | null
      sessions: Map<string, { projectPath?: string }>
      getActiveSession: () => { projectPath?: string } | null | undefined
    }
    if (chat.streamingSessionId) {
      const s = chat.sessions.get(chat.streamingSessionId)
      const p = normalizeProjectPath(s?.projectPath)
      if (p) return p
    }
    const active = chat.getActiveSession?.()
    const ap = normalizeProjectPath(active?.projectPath)
    if (ap) return ap
  } catch { /* tests */ }

  return normalizeProjectPath(useProjectStore.getState().currentProject?.path)
}

/** True when a parallel/project-run owns a live badge for this path. */
function hasLiveParallelOn(path: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useParallelTaskStore } = require('@/stores/parallelTaskStore') as {
      useParallelTaskStore: { getState: () => { runs: Map<string, { status: string; projectPath?: string }> } }
    }
    for (const r of useParallelTaskStore.getState().runs.values()) {
      if (
        normalizeProjectPath(r.projectPath) === path
        && (r.status === 'running' || r.status === 'queued')
      ) {
        return true
      }
    }
  } catch { /* store unavailable */ }
  return false
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
    const chat = useChatStore.getState()
    // A sessão DO RUN, não a visível: desde o modelo foreground (Fases 1-4) o
    // user pode estar a VER o chat de uma tarefa paralela enquanto o main
    // corre — o heartbeat lia getActiveSession() e o badge do run principal
    // herdava o NOME da tarefa (feedback do user 2026-07-17: "as duas tarefas
    // ficam com o mesmo nome"). streamingSessionId é onde o run vive.
    const session = chat.streamingSessionId
      ? chat.sessions.get(chat.streamingSessionId) ?? chat.getActiveSession()
      : chat.getActiveSession()
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
    // Path of the RUN, not merely the focused project (see resolveMainBadgePath).
    const path = resolveMainBadgePath()
    if (!path) return
    // If a previous main badge was left dangling (crash / missed terminal
    // transition), settle it before claiming a different project — otherwise
    // two recents keep "running" until staleness (90s).
    if (runningPath && runningPath !== path) {
      writeStatus(runningPath, 'idle', null, { onlyIfOwn: true })
    }
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

  // Already busy: if the bound project path changed mid-run (context set late,
  // or wrong path captured at first busy), re-stamp the correct project and
  // clear the wrong one so two recents don't both pulse "agora".
  if (wasBusy && isBusy && runningPath) {
    const livePath = resolveMainBadgePath()
    if (livePath && livePath !== runningPath) {
      writeStatus(runningPath, 'idle', null, { onlyIfOwn: true })
      runningPath = livePath
      const meta = extractTaskMeta()
      if (meta.label) runningLabel = meta.label
      runningDescription = meta.description
      writeStatus(runningPath, 'running', runningLabel, {
        startedAt: runningStartedAt ?? Date.now(),
        description: runningDescription,
      })
    }
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
    // A live project-run owns this path's badge — main must not stamp over it
    // (one-agent-per-project: if parallel is live here, main shouldn't be;
    // defensive against races on focus switch).
    if (hasLiveParallelOn(path)) {
      budgetStopLabel = null
      runningLabel = null
      runningDescription = null
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
  // In-window multi-project (F2): switching focus does NOT cancel the previous
  // project's run. The badge follows the RUN (runningPath) and is driven
  // ENTIRELY by onAgentStatusChange, never by focus. So leaving a project must
  // NOT stamp it 'idle' (that blanked a live 'running', and nulling runningPath
  // dropped the eventual done/error terminal write — the "badge fantasma" bug),
  // nor stop the heartbeat (which beats for whichever project owns the live run,
  // not the focused one). We only reconcile the project being OPENED; a real
  // cancel/close routes through onAgentStatusChange ('cancelled' → idle).
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
