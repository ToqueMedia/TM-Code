/**
 * Sub-agent result DELIVERY — event-driven, never polled.
 *
 * Product rule (2026-07-10): the main agent must NOT poll collect_results;
 * finished sub-agents deliver their results TO the agent. Two delivery paths:
 *
 *  1. MAIN AGENT BUSY → the formatted results are queued for the live run's
 *     steering channel (drainSubAgentDeliveries, consumed by both dispatch
 *     paths' collectSteeringMessages) and ride the NEXT turn boundary —
 *     mid-run, no waiting for idle.
 *  2. MAIN AGENT IDLE → a background auto-wake run starts WITH THE RESULTS
 *     EMBEDDED in the wake message ("team member taps you on the shoulder,
 *     handing you the report") — no collect_results round-trip.
 *
 * collect_results remains as a manual fallback (full untruncated text, or
 * when the user explicitly asks for team status).
 *
 * Includes debounce so N simultaneous finishes collapse into one delivery,
 * and an idle-transition fallback so deliveries queued for a run that ended
 * before draining are never lost (v0.7.1 pending-wake lineage).
 */

import { useAgentStore } from '../../../stores/agentStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useSubAgentStore } from '../../../stores/subAgentStore'
import { logger } from '../../../utils/logger'
import { buildTeamResultsReport } from './resultsReport'

let wakeTimer: ReturnType<typeof setTimeout> | null = null
const WAKE_DEBOUNCE_MS = 500

/** Per-run payload cap for pushed deliveries (full text via collect_results). */
const DELIVERY_PER_RUN_CHAR_CAP = 6_000

/** Runs whose results were already delivered (pushed or embedded in a wake).
 *  Pruned lazily against the store so clearCompleted() self-heals the set. */
const deliveredIds = new Set<string>()

/** Formatted result blocks waiting for the live run's steering drain. */
const pendingDeliveries: string[] = []

/** Drain queued sub-agent deliveries (joined) — called by the steering
 *  collectors at every turn boundary of a live foreground run. */
export function drainSubAgentDeliveries(): string | null {
  if (pendingDeliveries.length === 0) return null
  const text = pendingDeliveries.join('\n\n')
  pendingDeliveries.length = 0
  return text
}

/** True when deliveries are waiting (used by the idle fallback). */
export function hasPendingSubAgentDeliveries(): boolean {
  return pendingDeliveries.length > 0
}

/** Mark run results as already seen by the model (collect_results showed
 *  them) so the push path never re-delivers duplicates. */
export function markSubAgentResultsDelivered(ids: string[]): void {
  for (const id of ids) deliveredIds.add(id)
}

/** Listen for agent status transitions — delivers leftovers on idle. */
let subscribed = false
function ensureIdleListener(): void {
  if (subscribed) return
  subscribed = true
  useAgentStore.subscribe((state, prev) => {
    if (state.status === 'idle' && prev.status !== 'idle') {
      // A run ended. Anything still queued was NOT drained by its steering
      // collector (background run, or finish landed after the last turn
      // boundary) — deliver it via a wake instead of dropping it.
      if (pendingDeliveries.length > 0) {
        logger.info('agent', '→ Team delivery: undrained results at idle — waking with payload')
        if (wakeTimer) clearTimeout(wakeTimer)
        wakeTimer = setTimeout(doDeliver, WAKE_DEBOUNCE_MS)
      }
    }
  })
}

/**
 * Debounced delivery entry point — called by subAgentRunner whenever a run
 * finishes (completed/error/timeout). Multiple simultaneous finishes collapse
 * into a single delivery.
 */
export function maybeWakeMainAgent(): void {
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(doDeliver, WAKE_DEBOUNCE_MS)
}

/** Build the report for finished runs not yet delivered. */
function buildUndeliveredReport() {
  const store = useSubAgentStore.getState()
  // Self-heal the delivered set: forget ids the store no longer knows.
  const known = new Set(Array.from(store.runs.keys()))
  for (const id of deliveredIds) {
    if (!known.has(id)) deliveredIds.delete(id)
  }
  const summaries = store
    .getRunSummaries()
    .filter((s) => s.status === 'running' || !deliveredIds.has(s.id))
  return buildTeamResultsReport(summaries, {
    includeRunning: false,
    perRunCharCap: DELIVERY_PER_RUN_CHAR_CAP,
  })
}

function wrapDelivery(text: string, runningCount: number): string {
  const tail =
    runningCount > 0
      ? `${runningCount} team member${runningCount > 1 ? 's are' : ' is'} still working — their results will be DELIVERED to you the same way. Do not poll collect_results.`
      : 'All team members have finished.'
  return `[System: team results delivered below. Synthesize them into your work.]\n\n${text}\n${tail}`
}

function doDeliver(): void {
  wakeTimer = null

  const report = buildUndeliveredReport()
  if (report.finishedIds.length === 0) return

  for (const id of report.finishedIds) deliveredIds.add(id)
  const payload = wrapDelivery(report.text, report.runningCount)

  // Everything delivered and nothing running → the store's completed runs
  // have served their purpose (same lifecycle as collect_results).
  if (report.runningCount === 0) {
    useSubAgentStore.getState().clearCompleted()
  }

  const agentStatus = useAgentStore.getState().status
  if (agentStatus !== 'idle') {
    // Live run: hand the payload to the steering channel — it rides the next
    // turn boundary. The idle listener is the safety net if the run ends
    // without draining.
    pendingDeliveries.push(payload)
    ensureIdleListener()
    logger.info('agent', `→ Team delivery: queued for live run (${report.finishedIds.length} result(s))`)
    return
  }

  logger.info('agent', `→ Team delivery: waking idle agent with ${report.finishedIds.length} result(s)`)
  import('../agentRunner')
    .then(({ runAgentWithCallbacks }) => {
      const { currentProject, cmdModeProjectPath } = useProjectStore.getState()
      const cmdOnlyMode = !currentProject && !!cmdModeProjectPath

      runAgentWithCallbacks(payload, {
        addUserMessage: false,
        useConversationHistory: true,
        cmdOnlyMode,
        isBackgroundRun: true,
      })
    })
    .catch((err) => {
      logger.warn('agent', `Team delivery wake failed: ${err}`)
    })
}
