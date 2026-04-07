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
  subscribeToCommandQueue,
} from '../services/agent/messageQueue'
import { getQueryGuard } from '../services/agent/queryGuard'
import { processQueueIfReady } from '../services/agent/queueProcessor'
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

  useEffect(() => {
    if (isQueryActive) return
    if (queueSnapshot.length === 0) return

    // Reservation is owned by executeQueuedInput → handlePromptSubmit →
    // queryGuard.reserve()/tryStart(). The sync chain runs before the first
    // real await, so by the time React re-runs this effect (due to the
    // dequeue-triggered snapshot change), isQueryActive is already true
    // (dispatching) and the guard above returns early.
    processQueueIfReady({ executeInput: executeQueuedInput })
  }, [queueSnapshot, isQueryActive, executeQueuedInput])
}
