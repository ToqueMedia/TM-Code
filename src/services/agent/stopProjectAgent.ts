/**
 * Stop the agent bound to a SINGLE project without killing work on others.
 *
 * Global `stopAgentRun` cancels the main loop only (not parallel project-runs).
 * Multi-project MDI needs a per-path stop so the sidebar / activity dock can
 * halt a background project while another stays live.
 *
 * Stop channels (same process + cross-window):
 *  1. Local parallelTaskStore abort (immediate)
 *  2. Local main loop via stopAgentRun (immediate)
 *  3. Disk: project-level stop request + per-session task-stop-requests
 *     so another window's runner/main heartbeats can self-abort (≤30s).
 */

import { findLiveParallelRunForProject } from './parallelTasks/parallelTaskManager'
import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { useProjectStore } from '@/stores/projectStore'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { stopAgentRun } from './stopAgentRun'
import {
  requestProjectAgentStop,
  requestTaskStop,
} from './parallelTasks/taskStopRequestService'
import { sessionService } from './sessionService'
import { logger } from '@/utils/logger'
import type { AgentStatus } from '@/types/agent'

const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'awaiting_response',
  'reasoning',
  'generating',
  'applying',
  'compressing',
])

function normalizeProjectPath(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeProjectPath(a)
  const nb = normalizeProjectPath(b)
  return !!na && !!nb && na === nb
}

/** Abort every live parallel run for this project (normalized path match). */
function abortLocalParallelRuns(projectPath: string): boolean {
  const store = useParallelTaskStore.getState()
  let any = false
  for (const r of store.runs.values()) {
    if (
      pathsEqual(r.projectPath, projectPath)
      && (r.status === 'running' || r.status === 'queued')
    ) {
      store.abort(r.id)
      any = true
    }
  }
  // Fallback: manager helper (exact + norm) for older call sites / tests.
  if (!any) {
    const liveId =
      findLiveParallelRunForProject(normalizeProjectPath(projectPath))
      ?? findLiveParallelRunForProject(projectPath)
    if (liveId) {
      store.abort(liveId)
      any = true
    }
  }
  return any
}

/**
 * True when THIS process's main agent loop is bound to `projectPath`
 * (tool context, streaming session, or focused project while busy).
 */
function isLocalMainBusyOnProject(projectPath: string): boolean {
  try {
    // Lazy require: toolExecutor pulls a large dep graph; only needed at click time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ToolExecutor = require('./toolExecutor').default as {
      getInstance: () => { getProjectContext: () => { projectPath: string } | null }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentService = require('./agentService').default as {
      getInstance: () => { isAgentRunning: () => boolean }
    }
    const agentRunning = AgentService.getInstance().isAgentRunning()
    const busyUi = BUSY_STATUSES.has(useAgentStore.getState().status)
    if (!agentRunning && !busyUi) return false

    const ctx = ToolExecutor.getInstance().getProjectContext()
    if (pathsEqual(ctx?.projectPath, projectPath)) return true

    const chat = useChatStore.getState()
    if (chat.streamingSessionId) {
      const s = chat.sessions.get(chat.streamingSessionId)
      if (pathsEqual(s?.projectPath, projectPath)) return true
    }
    const active = chat.getActiveSession?.()
    if (pathsEqual(active?.projectPath, projectPath) && (agentRunning || busyUi)) {
      return true
    }

    const focused = useProjectStore.getState().currentProject?.path
    if (pathsEqual(focused, projectPath) && (agentRunning || busyUi)) {
      return true
    }
  } catch (err) {
    logger.warn('agent', 'stopProjectAgent main-path probe failed:', err)
  }
  return false
}

/**
 * Disk channel for other windows (and for a late local race). Fire-and-forget:
 * the owning runner/main consumes within a turn boundary or ≤30s heartbeat.
 */
function requestRemoteStops(projectPath: string): void {
  const norm = normalizeProjectPath(projectPath) || projectPath
  void requestProjectAgentStop(norm).catch(() => {})
  // Also stamp session-scoped stops for any live parallel-task sessions on disk
  // (older runners only watched session ids).
  void sessionService
    .listSessions(norm)
    .then((all) => {
      const now = Date.now()
      const STALE_MS = 90_000
      for (const s of all) {
        if (!s.id) continue
        // Session index only stamps terminal/running parallel statuses (no 'queued').
        if (s.parallelTaskStatus !== 'running') continue
        const updated = typeof s.updatedAt === 'number' ? s.updatedAt : 0
        if (updated && now - updated > STALE_MS) continue
        void requestTaskStop(norm, s.id)
      }
    })
    .catch(() => { /* best-effort */ })
}

/**
 * Stop whatever agent is live for `projectPath` in this process (or ask the
 * owning window via the cross-window stop channel). Returns true when a local
 * stop was issued; false when only a remote request was written (or nothing).
 */
export function stopProjectAgent(projectPath: string): boolean {
  if (!projectPath) return false
  const norm = normalizeProjectPath(projectPath) || projectPath

  // 1. Background project-run(s) owned by this window (parallel runner).
  if (abortLocalParallelRuns(norm)) {
    // Do NOT also write a disk stop: a fresh run starting in the next
    // seconds would consume it and die immediately (self-kill race).
    return true
  }

  // 2. Main loop bound to this project.
  if (isLocalMainBusyOnProject(norm)) {
    return stopAgentRun()
  }

  // 3. Cross-window (or local race where store/context not yet bound):
  //    write stop requests so the owner self-aborts (≤30s heartbeat / turn).
  requestRemoteStops(norm)
  logger.info('agent', `stopProjectAgent: no local run for ${norm} — remote stop requested`)
  return false
}
