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
  hasCommandsInQueue,
  isSlashCommand as isSlashCommandValue,
  peek,
} from './messageQueue'
import type { QueuedCommand } from '../../types/messageQueueTypes'

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
  /**
   * Session the queue is being drained FOR (the focused chat). Items
   * stamped with a different sessionId are foreign — see processQueueIfReady.
   * Optional for callers/tests that don't model sessions (treated as
   * "unknown" → every item drains through the legacy global path).
   */
  activeSessionId?: string | null
}

type ProcessQueueResult = {
  processed: boolean
}

/** True when the command may run in the ACTIVE session: unstamped (legacy)
 *  or stamped to it. Foreign-session prompts drain separately (their batch
 *  is routed by executeQueuedInput), foreign slash/bash stay parked. */
function belongsToActiveSession(
  cmd: QueuedCommand,
  activeSessionId: string | null | undefined,
): boolean {
  return !cmd.sessionId || !activeSessionId || cmd.sessionId === activeSessionId
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
  activeSessionId,
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

  // Session affiliation: items queued under a different session must NOT
  // run in the focused chat. Slash/bash commands of a foreign session stay
  // queued (their routing is bound to the ACTIVE session — they drain when
  // the user returns to that session). Prompt-mode items of a foreign
  // session drain and are routed to their own project/session runner by
  // executeQueuedInput.
  const isForeignSession =
    !!next.sessionId && !!activeSessionId && next.sessionId !== activeSessionId

  // Slash commands and bash-mode commands are processed individually.
  // Bash needs per-command error isolation; slash commands have side effects
  // that don't compose. F3: `asTask` is legacy — treated as a normal prompt.
  if (isSlashCommand(next) || next.mode === 'bash') {
    if (isForeignSession) {
      // Leave it parked for its own session; other items behind it can
      // still drain through the array-order batch window below.
      const slashCmd = next
      const batchMode = next.mode
      const batch = dequeueAllMatching(
        cmd =>
          cmd !== slashCmd
          && !isSlashCommand(cmd)
          && cmd.mode === batchMode
          && belongsToActiveSession(cmd, activeSessionId),
      )
      if (batch.length > 0) {
        dispatchVisible(executeInput, batch)
        return { processed: true }
      }
      return { processed: false }
    }
    const cmd = dequeue()!
    dispatchVisible(executeInput, [cmd])
    return { processed: true }
  }

  // Drain all non-slash items with the same mode at once — but never mix
  // destinations in one batch: a batch is dispatched as a single agent
  // turn, and a turn belongs to exactly one session. Two batch shapes:
  //  - foreign head → only that session's items (routed to their own
  //    project runner by executeQueuedInput);
  //  - active/legacy head → every item that will run in the ACTIVE session
  //    (stamped-to-active + unstamped legacy), preserving the historical
  //    single-turn coalescing.
  const targetMode = next.mode
  const commands = isForeignSession
    ? dequeueAllMatching(
        cmd =>
          !isSlashCommand(cmd)
          && cmd.mode === targetMode
          && cmd.sessionId === next.sessionId,
      )
    : dequeueAllMatching(
        cmd =>
          !isSlashCommand(cmd)
          && cmd.mode === targetMode
          && belongsToActiveSession(cmd, activeSessionId),
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
    dispatchVisible(executeInput, [cmd])
    return { processed: true }
  }

  dispatchVisible(executeInput, commands)
  return { processed: true }
}

/**
 * Despacho com rejeições VISÍVEIS (2026-08-03): o `void executeInput(...)`
 * puro engolia qualquer rejeição — o item já saíra da fila e nada reportava
 * a perda (apanhado pelos evals headless: fila a zero, status idle,
 * silêncio absoluto). Perder uma mensagem em silêncio é bug em QUALQUER
 * modo; a rejeição vira estado de erro do agente — a janela mostra-o e o
 * runner reporta-o no result.
 */
function dispatchVisible(
  executeInput: (commands: QueuedCommand[]) => Promise<void>,
  commands: QueuedCommand[],
): void {
  void executeInput(commands).catch(async (err) => {
    try {
      const { useAgentStore } = await import('../../stores/agentStore')
      const store = useAgentStore.getState()
      store.setError(
        `queue dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      store.setStatus('error')
    } catch {
      /* sem store não há onde reportar */
    }
  })
}

/**
 * Checks if the queue has pending commands.
 * Use this to determine if queue processing should be triggered.
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
