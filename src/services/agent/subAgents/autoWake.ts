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

/** Formatted result blocks waiting for a run's steering drain, POR DONO:
 *  'main' = run principal; qualquer outra chave = taskId de tarefa paralela
 *  (Fase 3 do modelo foreground — resultados nunca vazam entre agentes). */
const pendingDeliveriesByOwner = new Map<string, string[]>()
const MAIN_OWNER = 'main'

function ownerKey(ownerTaskId?: string): string {
  return ownerTaskId ?? MAIN_OWNER
}

/** Drain queued sub-agent deliveries (joined) — called by the steering
 *  collectors at every turn boundary of a live run (main OU tarefa). */
export function drainSubAgentDeliveries(ownerTaskId?: string): string | null {
  const key = ownerKey(ownerTaskId)
  const queue = pendingDeliveriesByOwner.get(key)
  if (!queue || queue.length === 0) return null
  const text = queue.join('\n\n')
  pendingDeliveriesByOwner.delete(key)
  return text
}

/** True when deliveries are waiting (used by the idle fallback). */
export function hasPendingSubAgentDeliveries(ownerTaskId?: string): boolean {
  return (pendingDeliveriesByOwner.get(ownerKey(ownerTaskId))?.length ?? 0) > 0
}

/** Mensagem direta AGENTE→AGENTE (Fase 6b, doutrina "sem deus"): entra na
 *  MESMA fila de entregas do dono — steering no próximo turn boundary do run
 *  vivo dele; main idle → wake/announce com payload (dança dos sub-agents). */
export function queueAgentMessage(targetOwnerTaskId: string | undefined, text: string): void {
  const key = ownerKey(targetOwnerTaskId)
  const queue = pendingDeliveriesByOwner.get(key) ?? []
  queue.push(text)
  pendingDeliveriesByOwner.set(key, queue)
  if (key === MAIN_OWNER) {
    ensureIdleListener()
    if (useAgentStore.getState().status === 'idle') maybeWakeMainAgent()
  }
}

/** Tarefa terminada/parada: os resultados dela já não têm destinatário. */
export function dropSubAgentDeliveriesForOwner(ownerTaskId: string): void {
  pendingDeliveriesByOwner.delete(ownerTaskId)
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
      if (hasPendingSubAgentDeliveries()) {
        logger.info('agent', '→ Team delivery: undrained results at idle — waking with payload')
        if (wakeTimer) clearTimeout(wakeTimer)
        wakeTimer = setTimeout(() => doDeliver(), WAKE_DEBOUNCE_MS)
      }
    }
  })
}

/**
 * Debounced delivery entry point — called by subAgentRunner whenever a run
 * finishes (completed/error/timeout). Multiple simultaneous finishes collapse
 * into a single delivery.
 */
const dirtyOwners = new Set<string>()

export function maybeWakeMainAgent(ownerTaskId?: string): void {
  dirtyOwners.add(ownerKey(ownerTaskId))
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(() => {
    const owners = Array.from(dirtyOwners)
    dirtyOwners.clear()
    for (const owner of owners) {
      doDeliver(owner === MAIN_OWNER ? undefined : owner)
    }
  }, WAKE_DEBOUNCE_MS)
}

/** Build the report for finished runs not yet delivered. */
function buildUndeliveredReport(ownerTaskId?: string) {
  const store = useSubAgentStore.getState()
  // Self-heal the delivered set: forget ids the store no longer knows.
  const known = new Set(Array.from(store.runs.keys()))
  for (const id of deliveredIds) {
    if (!known.has(id)) deliveredIds.delete(id)
  }
  const summaries = store
    .getRunSummaries()
    // Só os runs DESTE dono — resultados de uma tarefa nunca aparecem no
    // main (e vice-versa).
    .filter((s) => (s.ownerTaskId ?? undefined) === ownerTaskId)
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

function doDeliver(ownerTaskId?: string): void {
  wakeTimer = null

  const report = buildUndeliveredReport(ownerTaskId)
  if (report.finishedIds.length === 0) return

  for (const id of report.finishedIds) deliveredIds.add(id)
  const payload = wrapDelivery(report.text, report.runningCount)

  // Limpeza global só quando TODOS os runs (de qualquer dono) terminaram e
  // foram entregues — clearCompleted é owner-blind e apagaria resultados
  // ainda não entregues de outro dono.
  const allRuns = Array.from(useSubAgentStore.getState().runs.values())
  const everythingDeliveredAndDone = allRuns.every(
    (r) => r.status !== 'running' && deliveredIds.has(r.id),
  )
  if (everythingDeliveredAndDone) {
    useSubAgentStore.getState().clearCompleted()
  }

  if (ownerTaskId) {
    // Dono é uma TAREFA: os resultados vão à fila DELA — o collector de
    // steering do runner da tarefa drena no próximo turn boundary. Se a
    // tarefa já morreu, o cleanup do runner descarta (drop…ForOwner).
    const queue = pendingDeliveriesByOwner.get(ownerTaskId) ?? []
    queue.push(payload)
    pendingDeliveriesByOwner.set(ownerTaskId, queue)
    logger.info('agent', `→ Team delivery: queued for task ${ownerTaskId} (${report.finishedIds.length} result(s))`)
    return
  }

  const agentStatus = useAgentStore.getState().status
  if (agentStatus !== 'idle') {
    // Live run: hand the payload to the steering channel — it rides the next
    // turn boundary. The idle listener is the safety net if the run ends
    // without draining.
    const queue = pendingDeliveriesByOwner.get(MAIN_OWNER) ?? []
    queue.push(payload)
    pendingDeliveriesByOwner.set(MAIN_OWNER, queue)
    ensureIdleListener()
    logger.info('agent', `→ Team delivery: queued for live run (${report.finishedIds.length} result(s))`)
    return
  }

  logger.info('agent', `→ Team delivery: waking idle agent with ${report.finishedIds.length} result(s)`)
  import('../agentRunner')
    .then(({ runAgentWithCallbacks }) => {
      runAgentWithCallbacks(payload, {
        addUserMessage: false,
        useConversationHistory: true,
        isBackgroundRun: true,
      })
    })
    .catch((err) => {
      logger.warn('agent', `Team delivery wake failed: ${err}`)
    })
}
