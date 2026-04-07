/**
 * Message queue types — ported from Claude Code, trimmed to what TM Code
 * actually uses today.
 *
 * Claude Code defines a richer QueuedCommand (agentId, workload, origin,
 * bridgeOrigin, isMeta, orphanedPermission, preExpansionValue, ...) for
 * features TM Code does not yet have (subagents, cron, Remote Control,
 * proactive ticks, paste expansion). Those fields are deliberately NOT
 * mirrored — they can be added back when a feature requires them, with
 * the call site that introduces the field. Until then, every field below
 * has at least one real consumer.
 *
 * Adaptations from Claude Code:
 * - `value` is `string` only (Claude Code uses `string | ContentBlockParam[]`
 *   to inline images at the queue layer; TM Code keeps images in the
 *   `pastedContents` field as `Attachment[]`, resolved by the agent at
 *   execution time).
 * - `pastedContents` is `Attachment[]` instead of
 *   `Record<number, PastedContent>`. Functionally equivalent — both are
 *   "raw inputs captured at paste time, materialised later" — and TM
 *   Code's Attachment type already carries its own id.
 */

import type { Attachment } from './chat'

// === Prompt input modes ===

/**
 * Input modes for the prompt.
 *
 * - `prompt` — normal user message (default).
 * - `bash` — shell-mode command (`!cmd`); processed one-at-a-time so each
 *   gets its own exit code and progress UI. Reserved — TM Code does not
 *   yet route bash commands through the queue but the processor knows
 *   how to handle them.
 */
export type PromptInputMode = 'bash' | 'prompt'

// === Queue priority ===

/**
 * Queue priority levels.
 *
 *  - `now`   — Interrupt and send immediately. Aborts any in-flight tool
 *              call. Currently unused; reserved.
 *  - `next`  — Default for user input. Mid-turn drain in Claude Code; in
 *              TM Code collapses to between-turn drain because the agent
 *              loop does not yet support mid-turn injection.
 *  - `later` — End-of-turn drain. Reserved for future system notifications.
 *
 * The priority field is still respected for ordering — `now` items are
 * dequeued first, then `next`, then `later`. FIFO within the same level.
 */
export type QueuePriority = 'now' | 'next' | 'later'

// === Queued command ===

export type QueuedCommand = {
  /** The user's text. Plain string in TM Code (see file header). */
  value: string

  /** What kind of input this is — drives downstream routing. */
  mode: PromptInputMode

  /** Defaults to the priority implied by `mode` when enqueued. */
  priority?: QueuePriority

  /** Stable id, useful for `remove` and React keys. */
  uuid?: string

  /**
   * Raw attachments captured at enqueue time. Resolved (read from disk,
   * embedded as base64) at execution time so the model sees inline images.
   */
  pastedContents?: Attachment[]

  /**
   * When true, the input is treated as plain text even if it starts with
   * `/`. Used for remotely-received messages that should not trigger
   * local slash commands.
   */
  skipSlashCommands?: boolean
}

// === Operation log (persistence) ===

/**
 * Discrete queue operations. Recorded to disk so the queue's history can
 * be reconstructed for debugging.
 */
export type QueueOperation = 'enqueue' | 'dequeue' | 'remove'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /** Captured for `enqueue` ops when value is a string. */
  content?: string
}
