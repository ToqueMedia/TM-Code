/**
 * Cross-window agent-status **reader** poll cadence.
 * Kept free of projectStore/toolExecutor so unit tests can import constants
 * without pulling the Tauri graph.
 *
 * Writer heartbeats: see projectAgentStatusService
 * (3s focused / 30s background). Reader should not be the bottleneck when
 * the owner window is focused.
 */

/** Poll when the window is in the background / hidden. */
export const PROJECT_AGENT_STATUS_POLL_MS = 3_000
/**
 * Poll when visible — writer focused heartbeat is 3s; reader at 1.5s keeps
 * badge lag on the order of a couple of seconds end-to-end.
 */
export const PROJECT_AGENT_STATUS_POLL_FOCUSED_MS = 1_500

/**
 * @param visibilityState - When omitted, reads `document.visibilityState`.
 *   Pass an explicit string in tests / non-DOM hosts.
 */
export function projectAgentStatusPollIntervalMs(visibilityState?: string): number {
  const vis =
    arguments.length > 0
      ? visibilityState
      : (typeof document !== 'undefined' ? document.visibilityState : undefined)
  if (vis === 'visible') return PROJECT_AGENT_STATUS_POLL_FOCUSED_MS
  return PROJECT_AGENT_STATUS_POLL_MS
}
