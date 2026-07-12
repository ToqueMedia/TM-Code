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
  updatedAt: number
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
/** Last terminal (`done`/`error`) write — cleared on user acknowledgement. */
let terminalWrite: { path: string; state: 'done' | 'error' } | null = null

function writeStatus(
  projectPath: string,
  state: ProjectAgentRunState,
  label?: string | null,
): void {
  invoke('set_project_agent_status', {
    projectPath,
    state,
    label: label ?? null,
  }).catch(err => {
    logger.warn('agent', 'set_project_agent_status failed:', err)
  })
}

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (runningPath) writeStatus(runningPath, 'running', runningLabel)
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
  writeStatus(terminalWrite.path, 'idle')
  terminalWrite = null
}

/** Short excerpt of the task for the badge tooltip in other windows. */
function extractTaskLabel(): string | null {
  try {
    const session = useChatStore.getState().getActiveSession()
    if (!session) return null
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m.role === 'user' && typeof m.content === 'string') {
        const text = m.content.replace(/\s+/g, ' ').trim()
        if (!text) continue
        return text.length > 80 ? `${text.slice(0, 77)}…` : text
      }
    }
  } catch {
    /* non-critical */
  }
  return null
}

function onAgentStatusChange(status: AgentStatus, prevStatus: AgentStatus): void {
  const wasBusy = BUSY_STATUSES.has(prevStatus)
  const isBusy = BUSY_STATUSES.has(status)

  if (!wasBusy && isBusy) {
    const path = useProjectStore.getState().currentProject?.path
    if (!path) return
    runningPath = path
    runningLabel = extractTaskLabel()
    terminalWrite = null
    cancelAttendedClear()
    writeStatus(path, 'running', runningLabel)
    startHeartbeat()
    return
  }

  if (wasBusy && !isBusy) {
    stopHeartbeat()
    const path = runningPath
    runningPath = null
    if (!path) return
    if (status === 'error') {
      terminalWrite = { path, state: 'error' }
      writeStatus(path, 'error', runningLabel)
      scheduleAttendedClear()
    } else if (status === 'cancelled') {
      // Explicit user stop — attended by definition, no badge to keep.
      terminalWrite = null
      writeStatus(path, 'idle')
    } else {
      terminalWrite = { path, state: 'done' }
      writeStatus(path, 'done', runningLabel)
      scheduleAttendedClear()
    }
    runningLabel = null
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
    stopHeartbeat()
    cancelAttendedClear()
    if (runningPath === prevPath) runningPath = null
    if (terminalWrite?.path === prevPath) terminalWrite = null
    writeStatus(prevPath, 'idle')
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
