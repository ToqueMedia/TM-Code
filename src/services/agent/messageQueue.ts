/**
 * Message Queue Manager — adapted from Claude Code (utils/messageQueueManager.ts).
 *
 * Single unified command queue (module-level, independent of React state).
 * React components subscribe via useSyncExternalStore (subscribeToCommandQueue
 * / getCommandQueueSnapshot). Non-React code can read directly via
 * `hasCommandsInQueue()`.
 *
 * Priority determines dequeue order: 'now' > 'next' > 'later'.
 * Within the same priority, commands are processed FIFO.
 *
 * This file is the trimmed-for-TM-Code version. Helpers that exist in
 * Claude Code but have no consumer in TM Code today (popAllEditable,
 * enqueuePendingNotification, recheckCommandQueue, getCommandsByMaxPriority,
 * removeByFilter, getCommandQueue, getCommandQueueLength) have been
 * deliberately omitted — add them back when a feature requires them.
 *
 * Adaptations from Claude Code:
 * - `value` is `string` only (no SDK ContentBlockParam at the queue layer).
 *   Image attachments live in `pastedContents` as `Attachment[]` and are
 *   resolved at execution time.
 * - Logging goes through `recordQueueOperation` from `./queueOperationLog.ts`
 *   (writes JSONL to ~/.toquemedia-studio/sessions/{projectHash}/
 *   queue-operations.jsonl) instead of Claude Code's SQLite-backed
 *   sessionStorage.
 */

import type {
  QueueOperation,
  QueueOperationMessage,
  QueuedCommand,
  QueuePriority,
} from '../../types/messageQueueTypes'
import { createSignal } from '../../utils/signal'
import { getQueueLogSessionId, recordQueueOperation } from './queueOperationLog'

// ============================================================================
// Logging helper
// ============================================================================

function logOperation(operation: QueueOperation, content?: string): void {
  const sessionId = getQueueLogSessionId()
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    sessionId,
    ...(content !== undefined && { content }),
  }
  void recordQueueOperation(queueOp)
}

// ============================================================================
// Module state
// ============================================================================

const commandQueue: QueuedCommand[] = []
/** Frozen snapshot — recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}

// ============================================================================
// useSyncExternalStore interface
// ============================================================================

export const subscribeToCommandQueue = queueChanged.subscribe

export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ============================================================================
// Read operations (for non-React code)
// ============================================================================

export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

// ============================================================================
// Write operations
// ============================================================================

/**
 * Add a command to the queue. Defaults priority to 'next' (the user-input
 * default — ahead of 'later' notifications, behind 'now' interrupts).
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
  logOperation('enqueue', command.value)
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/**
 * Remove and return the highest-priority command, or undefined if empty.
 * Within the same priority level, commands are dequeued FIFO.
 *
 * Optional `filter` narrows the candidates: non-matching commands stay
 * in the queue untouched. Used by the queue processor to restrict to
 * main-thread commands when subagents are introduced.
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) return undefined

  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined

  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  logOperation('dequeue')
  return dequeued
}

/**
 * Remove and return the highest-priority command without removing it,
 * respecting the optional filter.
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) return undefined
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  if (bestIdx === -1) return undefined
  return commandQueue[bestIdx]
}

/**
 * Remove and return all commands matching a predicate, preserving order.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) matched.push(cmd)
    else remaining.push(cmd)
  }
  if (matched.length === 0) return []
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _ of matched) logOperation('dequeue')
  return matched
}

/**
 * Remove specific commands from the queue by reference identity.
 * Callers must pass the same object references that are in the queue.
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) return

  const before = commandQueue.length
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(commandQueue[i]!)) {
      commandQueue.splice(i, 1)
    }
  }

  if (commandQueue.length !== before) notifySubscribers()
  for (const _ of commandsToRemove) logOperation('remove')
}

/**
 * Clear all commands from the queue.
 * Used by Stop and by session-switch paths.
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) return
  commandQueue.length = 0
  notifySubscribers()
}

/** Test helper — clear queue and reset snapshot to a fresh frozen array. */
export function resetCommandQueue(): void {
  commandQueue.length = 0
  snapshot = Object.freeze([])
}

// ============================================================================
// Slash command + batching helpers
// ============================================================================

/**
 * Returns true if the command is a slash command. Commands with
 * `skipSlashCommands` (e.g. bridge messages) are NOT treated as slash
 * commands — their text is meant for the model.
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return cmd.value.trim().startsWith('/') && !cmd.skipSlashCommands
}

/**
 * Combine multiple prompt values into one. Single-value pass-through;
 * multiple values are newline-joined.
 *
 * Separator matches Claude Code (`cli/print.ts:431`) — single newline.
 * Each enqueued message reads as an adjacent line in the coalesced turn.
 */
export function joinPromptValues(values: string[]): string {
  if (values.length === 1) return values[0]!
  return values.join('\n')
}

/**
 * Whether `next` can be batched into the same agent turn as `head`.
 * Only prompt-mode commands batch.
 */
export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return next !== undefined && next.mode === 'prompt' && head.mode === 'prompt'
}

export type { QueuedCommand }
