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

// === Queue pause ===
//
// True while the idle drain must NOT dispatch anything. Set by Stop (queued
// tasks survive the stop, parked instead of firing the instant the guard
// goes idle — "Stop doesn't stop" bug), by the budget-stop watcher (parked
// work must not burn 402s and must survive until credits return), and on
// snapshot rehydrate when tasks are present (auto-firing agent runs at app
// boot without a user action would be a surprise). Cleared by the strip's
// "Resume" button, by any manual send (pressing Enter IS the intent to
// continue), and automatically when the queue empties.
let queuePaused = false
const pauseChanged = createSignal()

export const subscribeToQueuePause = pauseChanged.subscribe

export function isQueuePaused(): boolean {
  return queuePaused
}

export function setQueuePaused(paused: boolean): void {
  if (queuePaused === paused) return
  queuePaused = paused
  pauseChanged.emit()
}

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
  const { saveQueueSnapshot } = await import('./queueSnapshotPersistence')
  // Session-affiliated items are persisted under THEIR OWN (project,
  // session) pair — writing the whole queue under the focused context
  // cross-contaminated snapshots: project A's parked prompts resurfaced
  // in project B's strip after a reload. The FOCUSED pair's file holds its
  // slice IN QUEUE ORDER (its own stamped items + unstamped legacy items);
  // other sessions' stamped items go to their own files. Exactly ONE write
  // per pair — an earlier version also wrote the legacy slice under the
  // focused pair, racing the group write to the same file (last-write-wins
  // could drop the stamped items from disk).
  const groups = new Map<string, { projectPath: string; sessionId: string; items: QueuedCommand[] }>()
  const hasActivePair = !!activeProjectPath && !!activeSessionId
  const activeKey = hasActivePair ? `${activeProjectPath}\u0000${activeSessionId}` : null
  if (hasActivePair) {
    groups.set(activeKey!, {
      projectPath: activeProjectPath!,
      sessionId: activeSessionId!,
      items: commandQueue.filter(
        c =>
          !c.sessionId
          || (c.sessionId === activeSessionId
            && (c.projectPath ?? activeProjectPath) === activeProjectPath),
      ),
    })
  }
  for (const cmd of commandQueue) {
    if (!cmd.sessionId) continue
    const key = `${cmd.projectPath ?? ''}\u0000${cmd.sessionId}`
    if (groups.has(key)) continue
    groups.set(key, {
      projectPath: cmd.projectPath ?? activeProjectPath ?? '',
      sessionId: cmd.sessionId,
      items: commandQueue.filter(c => c.sessionId === cmd.sessionId
        && (c.projectPath ?? '') === (cmd.projectPath ?? '')),
    })
  }
  const writes: Promise<unknown>[] = []
  for (const group of groups.values()) {
    if (!group.projectPath) continue
    writes.push(saveQueueSnapshot(group.projectPath, group.sessionId, group.items))
  }
  // A pair whose items all drained must have its snapshot CLEARED, or the
  // consumed prompts resurrect from disk the next time that session loads.
  // The active pair is always written above (possibly empty) — no extra
  // clear needed for it.
  for (const key of Array.from(persistedPairKeys)) {
    if (groups.has(key)) continue
    const [projectPath, sessionId] = key.split('\u0000')
    if (projectPath) writes.push(saveQueueSnapshot(projectPath, sessionId, []))
  }
  persistedPairKeys = new Set(groups.keys())
  await Promise.all(writes)
}

/** (projectPath, sessionId) pairs present in the LAST persist — drained
 *  pairs get their snapshot cleared on the next write. */
let persistedPairKeys = new Set<string>()

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
  // Nothing left to resume — a lingering pause would silently freeze the
  // NEXT thing the user queues.
  if (commandQueue.length === 0) setQueuePaused(false)
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
  //
  // Rehydrated TASKS start paused: a task is a full agent run, and firing
  // one at app boot with zero user action (possibly hours after it was
  // queued) is a surprise — and, post budget-stop, a token burn. Steer-only
  // snapshots keep the historical auto-restore behaviour. The strip shows
  // the paused banner with a Resume button.
  setQueuePaused(items.some(c => c.asTask === true))
}

/**
 * Session-scoped rehydrate: replace THIS session's slice of the queue with
 * its disk snapshot while KEEPING live items that belong to other sessions
 * (their runs/strip depend on them). Used on chat-session switch — the old
 * full-replace either dropped other sessions' live items (snapshot
 * non-empty) or left this session's stale items rendering under the wrong
 * project (snapshot empty → no-op).
 */
export function hydrateCommandQueueForSession(
  items: QueuedCommand[],
  sessionId: string,
): void {
  // Live in-memory items of this session win over disk: they are newer
  // than the debounced snapshot (memory mutated → persist scheduled, disk
  // lags up to SNAPSHOT_PERSIST_DEBOUNCE_MS). Disk items only restore the
  // slice when memory has none (e.g. after a restart).
  const foreign = commandQueue.filter(c => c.sessionId && c.sessionId !== sessionId)
  const legacy = commandQueue.filter(c => !c.sessionId)
  const ownLive = commandQueue.filter(c => c.sessionId === sessionId)
  const next = [...foreign, ...legacy, ...(ownLive.length > 0 ? ownLive : items)]
  // Track hydrated pairs so a drain that fires before the next persist
  // still clears their disk snapshot (persist only clears keys it has
  // seen).
  for (const item of items) {
    if (item.sessionId) {
      persistedPairKeys.add(`${item.projectPath ?? ''}\u0000${item.sessionId}`)
    }
  }
  commandQueue.length = 0
  commandQueue.push(...next)
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
  setQueuePaused(items.some(c => c.asTask === true) || next.some(c => c.asTask === true))
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
 * Move a queued command one position up (-1) or down (+1). Queue order is
 * what the queue strip displays AND what the idle drain respects, so this
 * is the user's "run this one first" control. No-op at the edges or for
 * unknown uuids.
 */
export function moveInQueue(uuid: string, direction: -1 | 1): void {
  const idx = commandQueue.findIndex(c => c.uuid === uuid)
  if (idx === -1) return
  const target = idx + direction
  if (target < 0 || target >= commandQueue.length) return
  const [item] = commandQueue.splice(idx, 1)
  commandQueue.splice(target, 0, item!)
  notifySubscribers()
  logOperation('reorder')
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

/** Test helper — clear queue, pause flag, and snapshot. */
export function resetCommandQueue(): void {
  commandQueue.length = 0
  snapshot = Object.freeze([])
  queuePaused = false
  persistedPairKeys = new Set()
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
 * True when a queued command may be DRAINED AS STEERING into the live run
 * (ridden onto its next turn). Slash/bash commands need executeInput's
 * per-command handling, and TASK commands (`asTask`) are the opposite of
 * steering by contract: they wait for the current run to END and then start
 * as their own run. This predicate is the single source of truth shared by
 * BOTH steering collectors (agentRunner.ts and usePromptBar.ts — they must
 * stay in lockstep, see the 06-16 "queued messages only after the run" bug)
 * and mirrored by the idle-drain batching in queueProcessor.ts.
 */
export function isSteerable(cmd: QueuedCommand): boolean {
  return !isSlashCommand(cmd) && cmd.mode === 'prompt' && cmd.asTask !== true
}

/**
 * Drain the steerable messages the live run may absorb NOW: only those at or
 * above `maxPriority` and enqueued BEFORE the first task in queue order. A
 * steer message the user placed (or reordered) BELOW a task belongs to the
 * run that task will start, not to the current one — draining it here would
 * make the strip's order a lie. `later` messages stay queued for the idle
 * drain; the default carries only immediate (`now`) and normal (`next`)
 * steering into a live run.
 *
 * O corte por prioridade é um PREFIXO, não um filtro: ao encontrar a primeira
 * mensagem segurada por prioridade a janela FECHA ali. Filtrar salteado
 * partia o mesmo invariante que a fronteira de tarefas protege — com a fila
 * [L(later), N(next)], absorver o N e deixar o L para trás executava o N
 * primeiro enquanto a strip mostrava o L por cima. Nada abaixo de uma
 * mensagem segurada pode saltar-lhe à frente.
 *
 * This is the steering-collector counterpart of the batch window in
 * queueProcessor; both enforce "queue order is execution order".
 */
export function drainSteerableMessages(
  maxPriority: QueuePriority = 'next',
  opts?: { sessionId?: string | null },
): QueuedCommand[] {
  // Session gate: a message queued while viewing project A steers A's run,
  // never a run of another project that happens to be live when the turn
  // boundary hits. Unstamped (legacy) items keep the old behaviour.
  const belongsToRun = (cmd: QueuedCommand) =>
    !opts?.sessionId || !cmd.sessionId || cmd.sessionId === opts.sessionId
  const firstTaskIdx = commandQueue.findIndex(c => c.asTask === true)
  const window = firstTaskIdx === -1 ? commandQueue : commandQueue.slice(0, firstTaskIdx)
  const threshold = PRIORITY_ORDER[maxPriority]
  const eligible = new Set<QueuedCommand>()
  for (const cmd of window) {
    if (PRIORITY_ORDER[cmd.priority ?? 'next'] > threshold) break
    if (isSteerable(cmd) && belongsToRun(cmd)) eligible.add(cmd)
  }
  if (eligible.size === 0) return []
  return dequeueAllMatching(c => eligible.has(c))
}

/**
 * Drop steerable messages, keeping tasks (and slash/bash) in place.
 * Used by Stop: a steer message is a course correction for the run being
 * killed — meaningless afterwards — while queued TASKS are independent
 * units of work the user queued deliberately; they get parked (paused),
 * not destroyed.
 *
 * Session-scoped: with `sessionId` (the dying run's session), only THAT
 * session's steers die. Items queued under a different session belong to
 * a different conversation/runner and must survive a Stop issued here.
 */
export function removeSteerableMessages(opts?: { sessionId?: string | null }): void {
  const belongs =
    !opts?.sessionId
      ? () => true
      : (c: QueuedCommand) => !c.sessionId || c.sessionId === opts.sessionId
  dequeueAllMatching(c => isSteerable(c) && belongs(c))
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
