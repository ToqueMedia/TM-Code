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
 * - `value` is `string | ContentBlock[]` where ContentBlock is a local
 *   type (text or attachment) — Claude Code uses the Anthropic SDK's
 *   `ContentBlockParam[]` directly, but TM Code does not take that
 *   dependency at the queue layer. The agentService translates at the
 *   API boundary.
 * - Claude Code carries `pastedContents: Record<number, PastedContent>`
 *   alongside the value; TM Code keeps everything inline as blocks (no
 *   sidecar field), so a single message with an image is stored as
 *   `[{type:'text', text}, {type:'attachment', attachment}]`. Removes
 *   the dual-source-of-truth problem.
 */

import type { PromptBlock } from './chat'

// === Content blocks ===
//
// The block type is defined in types/chat.ts as `PromptBlock` so the
// chat store layer can produce/consume it without importing from the
// queue layer (avoids a name collision with the existing assistant
// `ContentBlock` type). The queue layer re-exports it as `ContentBlock`
// for back-compat with the existing call sites.

/**
 * Inline content blocks for queued commands. Mirrors Claude Code's
 * `ContentBlockParam[]` shape (Anthropic SDK) but defined locally so the
 * queue layer does not depend on the SDK. The agentService translates
 * to/from the SDK type at the API boundary.
 */
export type ContentBlock = PromptBlock

/** Either a plain string or a list of content blocks. */
export type PromptValue = string | ContentBlock[]

/**
 * Normalise a PromptValue to ContentBlock[]. Used by joinPromptValues
 * when at least one value is already blocks — the others have to be
 * promoted so the flatMap concatenates uniformly.
 */
export function toBlocks(value: PromptValue): ContentBlock[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [{ type: 'text', text: value }] : []
  }
  return value
}

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
 *  - `next`  — Default for user input. Mid-turn drain injects these
 *              between agent turns — the model sees queued messages
 *              and responds before deciding to stop.
 *  - `later` — End-of-turn drain. Reserved for future system notifications.
 *
 * The priority field is still respected for ordering — `now` items are
 * dequeued first, then `next`, then `later`. FIFO within the same level.
 */
export type QueuePriority = 'now' | 'next' | 'later'

// === Queued command ===

export type QueuedCommand = {
  /**
   * The user's input.
   *
   *  - Plain string for messages with no attachments.
   *  - ContentBlock[] when the message has attachments — the blocks
   *    interleave the user's text with each attachment in the order
   *    they appear in the message. Coalescing multiple such commands
   *    via joinPromptValues preserves that ordering across the merge.
   *
   * The display layer (chat bubble) and the API layer (agentService)
   * each walk the blocks at the boundary; the queue itself never
   * inspects the contents.
   */
  value: PromptValue

  /** What kind of input this is — drives downstream routing. */
  mode: PromptInputMode

  /** Defaults to the priority implied by `mode` when enqueued. */
  priority?: QueuePriority

  /** Stable id, useful for `remove` and React keys. */
  uuid?: string

  /**
   * When true, the input is treated as plain text even if it starts with
   * `/`. Used for remotely-received messages that should not trigger
   * local slash commands.
   */
  skipSlashCommands?: boolean

  /**
   * When true, this command is a QUEUED TASK: it must NOT be drained as
   * steering into the live run (messageQueue.isSteerable excludes it) and
   * the idle drain dispatches it as its OWN agent run, never coalesced
   * with other queued messages. This is the "queue a second feature while
   * the first is being built" flow — a steering message changes the
   * CURRENT task; a task waits its turn and starts fresh. Set by the
   * composer's Steer/Task toggle (usePromptBar) while the agent is busy.
   */
  asTask?: boolean
}

// === Operation log (persistence) ===

/**
 * Discrete queue operations. Recorded to disk so the queue's history can
 * be reconstructed for debugging.
 */
export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | 'reorder'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /** Captured for `enqueue` ops when value is a string. */
  content?: string
}
