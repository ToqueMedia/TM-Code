/**
 * Queue processor — ported from Claude Code (utils/queueProcessor.ts).
 *
 * Decides what to drain from the message queue and how to batch it before
 * handing the result to the caller's `executeInput` function.
 *
 * Behaviour, identical to Claude Code:
 *
 * - Slash commands and bash-mode commands are processed **one at a time**
 *   so each goes through `executeInput` individually. Bash commands need
 *   per-command error isolation, exit codes, and progress UI; slash
 *   commands have side effects that don't compose.
 * - Other non-slash commands are **batched**: all items with the same
 *   `mode` as the highest-priority item are drained at once and passed
 *   as a single array to `executeInput`. The caller's executeInput is
 *   expected to coalesce them into a single user-message + agent-loop.
 *   Different modes (e.g. prompt vs task-notification) are never mixed
 *   because they are treated differently downstream.
 * - The processor runs on the main thread between turns. Anything
 *   addressed to a subagent (`agentId !== undefined`) is left in the
 *   queue. TM Code does not yet have subagents, so this filter is a
 *   no-op today, but the contract matches Claude Code so the next sync
 *   doesn't have to re-introduce it.
 *
 * The caller is responsible for ensuring no query is currently running
 * before calling this, and for re-calling after each command completes
 * until the queue is empty.
 */

import {
  dequeue,
  dequeueAllMatching,
  getCommandQueueSnapshot,
  hasCommandsInQueue,
  isSlashCommand as isSlashCommandValue,
  peek,
} from './messageQueue'
import type { QueuedCommand } from '../../types/messageQueueTypes'

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

type ProcessQueueResult = {
  processed: boolean
}

/**
 * Check if a queued command is a slash command (value starts with '/').
 *
 * Wraps `messageQueue.isSlashCommand` for the local check site so the
 * processor doesn't import the function under the same name as a value
 * imported elsewhere — keeps the name visible in stack traces.
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  return isSlashCommandValue(cmd)
}

/**
 * Processes commands from the queue.
 *
 * @returns result with processed status
 */
export function processQueueIfReady({
  executeInput,
}: ProcessQueueParams): ProcessQueueResult {
  // Note: Claude Code's processor filters by `agentId === undefined` to
  // skip commands addressed to subagents. TM Code does not yet have
  // subagents, so the filter is omitted. When subagents are added,
  // re-introduce an `isMainThread` filter and pass it to peek/dequeue/
  // dequeueAllMatching.
  const next = peek()
  if (!next) {
    return { processed: false }
  }

  // Slash commands, bash-mode commands and QUEUED TASKS are processed
  // individually. Bash commands need per-command error isolation, exit
  // codes, and progress UI; slash commands have side effects that don't
  // compose; tasks (`asTask`) are their own agent run by definition —
  // coalescing one with other queued messages would merge two unrelated
  // pieces of work into a single turn.
  if (isSlashCommand(next) || next.mode === 'bash' || next.asTask === true) {
    const cmd = dequeue()!
    void executeInput([cmd])
    return { processed: true }
  }

  // Drain all non-slash items with the same mode at once — but only those
  // enqueued BEFORE the first task in queue order. Batching across a task
  // would silently run "message 3" ahead of "task 2" and break the order
  // the user sees (and reorders) in the queue strip.
  const snapshot = getCommandQueueSnapshot()
  const firstTaskIdx = snapshot.findIndex(c => c.asTask === true)
  const batchWindow = new Set(
    firstTaskIdx === -1 ? snapshot : snapshot.slice(0, firstTaskIdx),
  )
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => batchWindow.has(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) {
    // Priority reordering can make peek() pick an item the array-order
    // batch window excludes (e.g. a 'now'-priority steer parked AFTER a
    // task). Dispatch it alone instead of returning processed:false with a
    // non-empty queue — that would freeze the drain forever (no snapshot
    // change → useQueueProcessor's effect never re-fires). Unreachable
    // with today's enqueue sites (everything is 'next'), but one 'now'
    // enqueue away from a deadlock without this fallback.
    const cmd = dequeue()
    if (!cmd) return { processed: false }
    void executeInput([cmd])
    return { processed: true }
  }

  void executeInput(commands)
  return { processed: true }
}

/**
 * Checks if the queue has pending commands.
 * Use this to determine if queue processing should be triggered.
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
