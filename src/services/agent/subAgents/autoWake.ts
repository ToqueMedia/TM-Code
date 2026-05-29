/**
 * Auto-wake: when a sub-agent finishes and the main agent is idle,
 * inject a synthetic user message to wake the agent and collect results.
 *
 * Creates the "team member taps you on the shoulder" experience —
 * the agent wakes up, calls collect_results, synthesizes, and goes back to sleep.
 *
 * Includes debounce to prevent N simultaneous wake-ups when N sub-agents finish at once.
 */

import { useAgentStore } from '../../../stores/agentStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useSubAgentStore } from '../../../stores/subAgentStore'
import { logger } from '../../../utils/logger'

let wakeTimer: ReturnType<typeof setTimeout> | null = null
const WAKE_DEBOUNCE_MS = 500

/**
 * Debounced wake: waits 500ms after the last call so that multiple
 * simultaneous finishes (N sub-agents completing at once) collapse
 * into a single agent turn.
 */
export function maybeWakeMainAgent(): void {
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(doWake, WAKE_DEBOUNCE_MS)
}

function doWake(): void {
  wakeTimer = null

  const agentStatus = useAgentStore.getState().status
  if (agentStatus !== 'idle') return

  const runs = useSubAgentStore.getState().runs
  let finishedCount = 0
  let runningCount = 0
  const finishedNames: string[] = []

  for (const run of runs.values()) {
    if (run.status === 'running') {
      runningCount++
    } else if (run.status !== 'aborted') {
      finishedCount++
      finishedNames.push(`${run.definition.agentType}: "${run.description}"`)
    }
  }

  if (finishedCount === 0) return

  const status = runningCount > 0
    ? `${finishedCount} team member${finishedCount > 1 ? 's' : ''} finished (${runningCount} still running)`
    : `All ${finishedCount} team member${finishedCount > 1 ? 's have' : ' has'} finished`

  const names = finishedNames.join(', ')
  const wakeMessage = `[System: ${status}: ${names}. Use collect_results to get their results.]`

  logger.info('agent', `→ Auto-wake: ${status}`)

  import('../agentRunner').then(({ runAgentWithCallbacks }) => {
    const { currentProject, cmdModeProjectPath } = useProjectStore.getState()
    const cmdOnlyMode = !currentProject && !!cmdModeProjectPath

    runAgentWithCallbacks(wakeMessage, {
      addUserMessage: false,
      useConversationHistory: true,
      cmdOnlyMode,
    })
  }).catch((err) => {
    logger.warn('agent', `Auto-wake failed: ${err}`)
  })
}
