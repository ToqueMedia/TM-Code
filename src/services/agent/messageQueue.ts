/**
 * Message Queue Manager — ported from Claude Code (utils/messageQueueManager.ts).
 *
 * Single unified command queue (module-level, independent of React state).
 * All commands — user input, task notifications, orphaned permissions —
 * go through this one queue. React components subscribe via
 * useSyncExternalStore (subscribeToCommandQueue / getCommandQueueSnapshot).
 * Non-React code reads directly via getCommandQueue() / getCommandQueueLength().
 *
 * Priority determines dequeue order: 'now' > 'next' > 'later'.
 * Within the same priority, commands are processed FIFO.
 *
 * Adaptations from Claude Code:
 * - `value` is `string` only (TM Code does not depend on the Anthropic SDK
 *   ContentBlockParam type at the queue layer). Image attachments live in
 *   `pastedContents` as `Attachment[]` and are resolved at execution time.
 * - `popAllEditable` returns a simpler shape — TM Code's textarea does not
 *   need cursor offset bookkeeping in the same way; it does need text +
 *   attachments to splice back into the draft input.
 * - Logging goes through `recordQueueOperation` from
 *   `./queueOperationLog.ts` (which writes to `~/.toquemedia-studio/sessions/
 *   {projectHash}/queue-operations.jsonl`) instead of Claude Code's SQLite
 *   `sessionStorage.recordQueueOperation`.
 * - The KAIROS feature flag check in `isQueuedCommandVisible` is dropped —
 *   TM Code does not have feature flags and does not run KAIROS channels.
 * - Backward-compat aliases (subscribeToPendingNotifications etc.) are
 *   omitted because TM Code is being migrated wholesale; no consumer
 *   references the old names.
 */

import type { Attachment } from '../../types/chat'
import type {
  EditablePromptInputMode,
  PromptInputMode,
  QueueOperation,
  QueueOperationMessage,
  QueuedCommand,
  QueuedPastedContent,
  QueuePriority,
} from '../../types/messageQueueTypes'
import { objectGroupBy } from '../../utils/objectGroupBy'
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
// Unified command queue (module-level, independent of React state)
//
// All commands — user input, task notifications, orphaned permissions — go
// through this single queue. React components subscribe via
// useSyncExternalStore (subscribeToCommandQueue / getCommandQueueSnapshot).
// Non-React code reads directly via getCommandQueue() / getCommandQueueLength().
//
// Priority determines dequeue order: 'now' > 'next' > 'later'.
// Within the same priority, commands are processed FIFO.
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

/**
 * Subscribe to command queue changes.
 * Compatible with React's useSyncExternalStore.
 */
export const subscribeToCommandQueue = queueChanged.subscribe

/**
 * Get current snapshot of the command queue.
 * Compatible with React's useSyncExternalStore.
 * Returns a frozen array that only changes reference on mutation.
 */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ============================================================================
// Read operations (for non-React code)
// ============================================================================

/**
 * Get a mutable copy of the current queue.
 * Use for one-off reads where you need the actual commands.
 */
export function getCommandQueue(): QueuedCommand[] {
  return [...commandQueue]
}

/**
 * Get the current queue length without copying.
 */
export function getCommandQueueLength(): number {
  return commandQueue.length
}

/**
 * Check if there are commands in the queue.
 */
export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

/**
 * Trigger a re-check by notifying subscribers.
 * Use after async processing completes to ensure remaining commands
 * are picked up by useSyncExternalStore consumers.
 */
export function recheckCommandQueue(): void {
  if (commandQueue.length > 0) {
    notifySubscribers()
  }
}

// ============================================================================
// Write operations
// ============================================================================

/**
 * Add a command to the queue.
 * Used for user-initiated commands (prompt, bash, orphaned-permission).
 * Defaults priority to 'next' (processed before task notifications).
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
  logOperation('enqueue', typeof command.value === 'string' ? command.value : undefined)
}

/**
 * Add a task notification to the queue.
 * Convenience wrapper that defaults priority to 'later' so user input
 * is never starved by system messages.
 */
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' })
  notifySubscribers()
  logOperation('enqueue', typeof command.value === 'string' ? command.value : undefined)
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
 * An optional `filter` narrows the candidates: only commands for which the
 * predicate returns `true` are considered. Non-matching commands stay in the
 * queue untouched. This lets between-turn drains restrict to main-thread
 * commands (`cmd.agentId === undefined`) without restructuring the existing
 * while-loop patterns.
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  // Find the first command with the highest priority (respecting filter)
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
 * Remove and return all commands from the queue.
 * Logs a dequeue operation for each command.
 */
export function dequeueAll(): QueuedCommand[] {
  if (commandQueue.length === 0) {
    return []
  }

  const commands = [...commandQueue]
  commandQueue.length = 0
  notifySubscribers()

  for (const _cmd of commands) {
    logOperation('dequeue')
  }

  return commands
}

/**
 * Return the highest-priority command without removing it, or undefined if empty.
 * Accepts an optional `filter` — only commands passing the predicate are considered.
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }
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
 * Remove and return all commands matching a predicate, preserving priority order.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) {
      matched.push(cmd)
    } else {
      remaining.push(cmd)
    }
  }
  if (matched.length === 0) {
    return []
  }
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _cmd of matched) {
    logOperation('dequeue')
  }
  return matched
}

/**
 * Remove specific commands from the queue by reference identity.
 * Callers must pass the same object references that are in the queue
 * (e.g. from getCommandsByMaxPriority). Logs a 'remove' operation for each.
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return
  }

  const before = commandQueue.length
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(commandQueue[i]!)) {
      commandQueue.splice(i, 1)
    }
  }

  if (commandQueue.length !== before) {
    notifySubscribers()
  }

  for (const _cmd of commandsToRemove) {
    logOperation('remove')
  }
}

/**
 * Remove commands matching a predicate.
 * Returns the removed commands.
 */
export function removeByFilter(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (predicate(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }

  if (removed.length > 0) {
    notifySubscribers()
    for (const _cmd of removed) {
      logOperation('remove')
    }
  }

  return removed
}

/**
 * Clear all commands from the queue.
 * Used by ESC cancellation to discard queued notifications.
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) {
    return
  }
  commandQueue.length = 0
  notifySubscribers()
}

/**
 * Clear all commands and reset snapshot.
 * Used for test cleanup.
 */
export function resetCommandQueue(): void {
  commandQueue.length = 0
  snapshot = Object.freeze([])
}

// ============================================================================
// Editable mode helpers
// ============================================================================

const NON_EDITABLE_MODES = new Set<PromptInputMode>(['task-notification'])

export function isPromptInputModeEditable(
  mode: PromptInputMode,
): mode is EditablePromptInputMode {
  return !NON_EDITABLE_MODES.has(mode)
}

/**
 * Whether this queued command can be pulled into the input buffer via UP/ESC.
 * System-generated commands contain raw XML and must not leak into the
 * user's input.
 */
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta
}

/**
 * Whether this queued command should render in the queue preview under the
 * prompt. In Claude Code this is a superset of editable (channel messages
 * show even though they stay non-editable). TM Code currently has no
 * channel sources so it collapses to `isQueuedCommandEditable`.
 */
export function isQueuedCommandVisible(cmd: QueuedCommand): boolean {
  return isQueuedCommandEditable(cmd)
}

export type PopAllEditableResult = {
  text: string
  cursorOffset: number
  attachments: Attachment[]
}

/**
 * Pop all editable commands and combine them with current input for editing.
 * Notification modes (task-notification) are left in the queue
 * to be auto-processed later.
 *
 * Returns object with combined text, cursor offset, and attachments to restore.
 * Returns undefined if no editable commands in queue.
 */
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number,
): PopAllEditableResult | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  const { editable = [], nonEditable = [] } = objectGroupBy(
    [...commandQueue],
    cmd => (isQueuedCommandEditable(cmd) ? 'editable' : 'nonEditable'),
  )

  if (editable.length === 0) {
    return undefined
  }

  // Each command's value is a plain string in TM Code.
  const queuedTexts = editable.map(cmd => cmd.value)
  const newInput = [...queuedTexts, currentInput].filter(Boolean).join('\n')

  // Cursor offset: combined queued text length + 1 (newline) + current cursor.
  const cursorOffset = queuedTexts.join('\n').length + 1 + currentCursorOffset

  // Collect attachments from each popped command, preserving order.
  const attachments: Attachment[] = []
  for (const cmd of editable) {
    if (cmd.pastedContents) {
      for (const att of cmd.pastedContents) {
        attachments.push(att)
      }
    }
  }

  for (const command of editable) {
    logOperation('popAll', typeof command.value === 'string' ? command.value : undefined)
  }

  // Replace queue contents with only the non-editable commands
  commandQueue.length = 0
  commandQueue.push(...nonEditable)
  notifySubscribers()

  return { text: newInput, cursorOffset, attachments }
}

/**
 * Get commands at or above a given priority level without removing them.
 * Useful for mid-chain draining where only urgent items should be processed.
 *
 * Priority order: 'now' (0) > 'next' (1) > 'later' (2).
 * Passing 'now' returns only now-priority commands; 'later' returns everything.
 */
export function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return commandQueue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/**
 * Returns true if the command is a slash command that should be routed
 * through the slash command pipeline rather than sent to the model as text.
 *
 * Commands with `skipSlashCommands` (e.g. bridge/CCR messages) are NOT
 * treated as slash commands — their text is meant for the model.
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}

// ============================================================================
// Batching helpers — ported from Claude Code (cli/print.ts joinPromptValues
// and canBatchWith). Used by the executeInput callback to coalesce
// consecutive prompt-mode commands into a single agent turn.
// ============================================================================

/**
 * Combine multiple prompt values into one. Single-value pass-through;
 * multiple values are newline-joined.
 *
 * Claude Code's version handles `string | ContentBlockParam[]` (mixed
 * values are normalised to blocks); TM Code only carries strings at the
 * queue layer so this collapses to a join.
 */
export function joinPromptValues(values: string[]): string {
  if (values.length === 1) return values[0]!
  return values.join('\n\n')
}

/**
 * Whether `next` can be batched into the same agent turn as `head`. Only
 * prompt-mode commands batch, and only when the workload tag matches (so
 * the combined turn is attributed correctly) and the isMeta flag matches
 * (so a system tick can't merge into a user prompt).
 */
export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
}

// Re-export the QueuedPastedContent alias so callers don't have to import
// from messageQueueTypes for the common case.
export type { QueuedCommand, QueuedPastedContent }
