/**
 * Queue Processor Hook — ported from Claude Code (hooks/useQueueProcessor.ts).
 *
 * Subscribes to both the QueryGuard (agent state) and the unified command
 * queue. When the agent finishes AND the queue has items, fires
 * processQueueIfReady which decides what to drain (one-at-a-time vs batched
 * by mode) and calls back into the caller-supplied executeQueuedInput.
 *
 * Adaptations from Claude Code:
 * - The QueryGuard instance is read from a module-level singleton via
 *   `getQueryGuard()` instead of being threaded through props. TM Code
 *   has a single agent service rather than per-REPL guards.
 * - The `hasActiveLocalJsxUI` parameter is dropped — TM Code does not
 *   render local JSX overlays that block input the way Ink does. The
 *   pendingPermission gate is handled at the prompt-bar level, before
 *   enqueue, so the processor itself does not need to filter for it.
 */

import { useEffect, useSyncExternalStore } from 'react'
import {
  getCommandQueueSnapshot,
  isQueuePaused,
  subscribeToCommandQueue,
  subscribeToQueuePause,
} from '../services/agent/messageQueue'
import { getQueryGuard } from '../services/agent/queryGuard'
import { processQueueIfReady } from '../services/agent/queueProcessor'
import { useBillingStore } from '../stores/billingStore'
import { usePermissionStore } from '../stores/permissionStore'
import type { QueuedCommand } from '../types/messageQueueTypes'

type UseQueueProcessorParams = {
  /** Callback to execute queued commands. Receives one or many depending on
   *  what processQueueIfReady decided to drain. */
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
}

/**
 * Hook that processes queued commands when conditions are met.
 *
 * Uses a single unified command queue (module-level store). Priority
 * determines processing order: 'now' > 'next' (user input) > 'later'
 * (task notifications). The dequeue() function handles priority ordering
 * automatically.
 *
 * Processing triggers when:
 * - No query active (queryGuard, reactive via useSyncExternalStore)
 * - No permission dialog open (would render a new turn under a modal)
 * - Queue has items
 */
export function useQueueProcessor({
  executeQueuedInput,
}: UseQueueProcessorParams): void {
  const queryGuard = getQueryGuard()

  // Subscribe to the query guard. Re-renders when a query starts or ends
  // (or when reserve/cancelReservation transitions dispatching state).
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )

  // Subscribe to the unified command queue via useSyncExternalStore.
  // This guarantees re-render when the store changes.
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  // Block draining while a permission dialog is open. Without this, the
  // queue could fire a new turn while the user is still mid-decision on
  // the previous turn's permission prompt — the new turn would either
  // collide with the open dialog or auto-fire another one.
  const hasPendingPermission = usePermissionStore(s => !!s.pendingPermission)

  // Explicit pause (Stop with parked tasks / budget stop / task rehydrate).
  // Resumed by the strip's Resume button or any manual send.
  const queuePaused = useSyncExternalStore(subscribeToQueuePause, isQueuePaused)

  // Billing gate: while credits are exhausted, HOLD the queue instead of
  // draining it. The Chat dispatch path (runAgentForPrompt) has no billing
  // pre-flight, so without this gate every queued item was dequeued,
  // dispatched as a REAL request, 402'd, and destroyed — burning one
  // round-trip per item and leaving nothing to resume after a purchase.
  // When noCredits clears (post-purchase /v1/me or headers), this selector
  // flips and the effect re-fires with the queue intact.
  const billingBlocked = useBillingStore(s => s.noCredits || s.status === 'rejected')

  useEffect(() => {
    if (isQueryActive) return
    if (hasPendingPermission) return
    if (queuePaused) return
    if (billingBlocked) return
    if (queueSnapshot.length === 0) return

    // Reservation is owned by executeQueuedInput → runAgentLoop →
    // queryGuard.tryStart(). The sync chain runs before the first real
    // await, so by the time React re-runs this effect (due to the
    // dequeue-triggered snapshot change), isQueryActive is already true
    // (dispatching) and the guard above returns early.
    processQueueIfReady({ executeInput: executeQueuedInput })
  }, [queueSnapshot, isQueryActive, hasPendingPermission, queuePaused, billingBlocked, executeQueuedInput])
}
