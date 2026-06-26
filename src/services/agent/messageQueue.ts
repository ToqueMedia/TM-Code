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
 *   (writes JSONL to app-managed project state) instead of Claude Code's
 *   SQLite-backed sessionStorage.
 */

import {
  toBlocks,
  type PromptValue,
  type QueueOperation,
  type QueueOperationMessage,
  type QueuedCommand,
  type QueuePriority,
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

// === Snapshot persistence ===
//
// Every queue mutation triggers a debounced write to
// app-managed project state so a crash mid-batch doesn't silently lose user
// prompts. 200ms debounce —
// queue mutations are rare; the cost of waiting longer outweighs the cost
// of duplicate writes.
let snapshotPersistTimeout: ReturnType<typeof setTimeout> | null = null
const SNAPSHOT_PERSIST_DEBOUNCE_MS = 200

function scheduleSnapshotPersist(): void {
  // Use the queueLogContext (set by chatStore on createSession /
  // setActiveSession) to find the right destination. If no context is
  // set yet (very early app boot, no project), the persist is skipped —
  // there's nothing to snapshot to anyway.
  if (snapshotPersistTimeout) clearTimeout(snapshotPersistTimeout)
  snapshotPersistTimeout = setTimeout(() => {
    snapshotPersistTimeout = null
    void persistSnapshotNow()
  }, SNAPSHOT_PERSIST_DEBOUNCE_MS)
}

async function persistSnapshotNow(): Promise<void> {
  // Lazy import to avoid a cycle: queueOperationLog imports from this
  // module too. Resolving inside the timer callback keeps the module
  // graph clean.
  const { activeProjectPath, activeSessionId } = await getQueueContext()
  if (!activeProjectPath || !activeSessionId) return
  const { saveQueueSnapshot } = await import('./queueSnapshotPersistence')
  await saveQueueSnapshot(activeProjectPath, activeSessionId, snapshot)
}

async function getQueueContext(): Promise<{
  activeProjectPath: string | null
  activeSessionId: string | null
}> {
  const mod = await import('./queueOperationLog')
  // queueOperationLog already tracks the active (project, session) pair
  // for its own JSONL writes. Re-using it keeps the source-of-truth
  // single — no second context var to keep in sync.
  return {
    activeProjectPath: mod.getQueueLogProjectPath(),
    activeSessionId: mod.getQueueLogSessionId() === 'unknown'
      ? null
      : mod.getQueueLogSessionId(),
  }
}

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
  scheduleSnapshotPersist()
}

/**
 * Replace the queue with `items` and notify subscribers. Used by the
 * snapshot rehydrate path on chat-session load — restores pending
 * prompts a previous crash/quit left unprocessed.
 *
 * NOT exposed as a general-purpose API — callers that want to mutate
 * the queue should go through enqueue/dequeue/etc. This one bypasses
 * the per-operation log on purpose: we don't want a "100 enqueue
 * operations" burst in the log every time the IDE reopens.
 */
export function hydrateCommandQueue(items: QueuedCommand[]): void {
  commandQueue.length = 0
  commandQueue.push(...items)
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
  // Don't trigger a write here — the items came FROM disk, no new state.
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
 * Extract a string representation of a command's value for logging.
 * Strings pass through; block arrays are flattened to their text content
 * (attachment blocks become a placeholder marker).
 */
function valueToLogString(value: PromptValue): string {
  if (typeof value === 'string') return value
  return value
    .map(b => (b.type === 'text' ? b.text : `[attachment:${b.attachment.name}]`))
    .join(' ')
}

/**
 * Add a command to the queue. Defaults priority to 'next' (the user-input
 * default — ahead of 'later' notifications, behind 'now' interrupts).
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
  logOperation('enqueue', valueToLogString(command.value))
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
 *
 * For block-valued commands, only the first text block is inspected —
 * matching Claude Code's behaviour where the slash routing key has to
 * be at the very start of the message.
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  if (cmd.skipSlashCommands) return false
  if (typeof cmd.value === 'string') {
    return cmd.value.trim().startsWith('/')
  }
  const first = cmd.value[0]
  if (!first || first.type !== 'text') return false
  return first.text.trim().startsWith('/')
}

/**
 * Combine multiple prompt values into one.
 *
 * Ported from Claude Code (`cli/print.ts:428`):
 *  - Single value: pass through
 *  - All values are strings: newline-join
 *  - Any value is blocks: normalise everything to blocks, concat via flatMap
 *
 * The block path is what preserves the order "msg1 → img1 → msg2 → img2"
 * across coalesced commands. Without it, three messages each with their
 * own image would produce "all text first, all images at the end" and the
 * model would lose the correspondence.
 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
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
