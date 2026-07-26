/**
 * Cross-window OS focus (parallel residual).
 *
 * Channel: disk only — `focus-request.json` under the project state dir.
 * Writer: a window that wants the project's owning process to come forward
 * (`requestFocusForProject`). Consumer: owning window polls and calls
 * `focus_main_window` (`consumeFocusRequestIfAny` / `startFocusRequestConsumer`).
 *
 * UX: first click on a foreign running/done project → focus request + toast.
 * Second click within SECOND_CLICK_OPEN_MS → open locally (explicit fallback;
 * never auto-opens a second view while the first request may still land).
 */

import { invoke } from '@/utils/invokeMetrics'
import { logger } from '@/utils/logger'
import type { ProjectAgentStatus } from '@/services/projectAgentStatusService'

export type FocusOrOpenResult = 'focused' | 'opened' | 'failed'

/** Re-click the same project within this window to force open here. */
export const SECOND_CLICK_OPEN_MS = 8_000

let lastFocusRequest: { path: string; at: number } | null = null

/** Whether agent-status looks like a foreign process still relevant for focus. */
export function isForeignAgentStatus(
  status: ProjectAgentStatus | null | undefined,
): boolean {
  if (!status) return false
  if (typeof status.pid !== 'number' || status.pid <= 0) return false
  // Prefer focusing when the other window is mid-run; also when terminal
  // badges remain (user often clicks the finished project to return to it).
  return (
    status.state === 'running'
    || status.state === 'done'
    || status.state === 'error'
  )
}

/**
 * Ask the foreign window that already owns this project to focus.
 * @returns true when a foreign owner was targeted.
 */
export async function requestFocusForProject(projectPath: string): Promise<boolean> {
  if (!projectPath) return false
  try {
    return await invoke<boolean>('request_project_window_focus', { projectPath })
  } catch (err) {
    logger.warn('agent', 'request_project_window_focus failed:', err)
    return false
  }
}

/**
 * If another window asked US to focus (for this project), bring main to front.
 * @returns true when a request was consumed and focus invoked.
 */
export async function consumeFocusRequestIfAny(projectPath: string): Promise<boolean> {
  if (!projectPath) return false
  try {
    const mine = await invoke<boolean>('take_project_window_focus_request', {
      projectPath,
    })
    if (!mine) return false
    await invoke('focus_main_window')
    return true
  } catch (err) {
    logger.warn('agent', 'consumeFocusRequestIfAny failed:', err)
    return false
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Prefer focusing a foreign owner. Second click on the same path within
 * SECOND_CLICK_OPEN_MS opens locally. When no foreign owner, opens immediately.
 */
export async function focusForeignOrOpen(
  projectPath: string,
  status: ProjectAgentStatus | null | undefined,
  onOpen: () => void,
  opts?: {
    onFocusRequested?: () => void
  },
): Promise<FocusOrOpenResult> {
  if (!projectPath) {
    onOpen()
    return 'opened'
  }

  const norm = normalizePath(projectPath)
  const now = Date.now()
  const secondClick =
    lastFocusRequest
    && lastFocusRequest.path === norm
    && now - lastFocusRequest.at < SECOND_CLICK_OPEN_MS

  if (secondClick) {
    lastFocusRequest = null
    onOpen()
    return 'opened'
  }

  if (!isForeignAgentStatus(status)) {
    lastFocusRequest = null
    onOpen()
    return 'opened'
  }

  const targeted = await requestFocusForProject(projectPath)
  if (!targeted) {
    lastFocusRequest = null
    onOpen()
    return 'opened'
  }

  lastFocusRequest = { path: norm, at: now }
  opts?.onFocusRequested?.()
  return 'focused'
}

// ── Idle consumer: focus requests for the CURRENT project even when agent idle ──

let consumerTimer: ReturnType<typeof setInterval> | null = null
let consumerStarted = false

/**
 * Poll focus-request for the focused project so a *finished* agent window
 * still comes to the front when another window clicks its recents row.
 */
export function startFocusRequestConsumer(
  getProjectPath: () => string | null | undefined,
): void {
  if (consumerStarted) return
  consumerStarted = true
  const tick = () => {
    const path = getProjectPath()
    if (path) void consumeFocusRequestIfAny(path)
  }
  consumerTimer = setInterval(tick, 2_000)
  tick()
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick()
    })
  }
}

/** Test helper. */
export function stopFocusRequestConsumer(): void {
  if (consumerTimer) {
    clearInterval(consumerTimer)
    consumerTimer = null
  }
  consumerStarted = false
  lastFocusRequest = null
}
