/**
 * Message queue types — ported from Claude Code.
 *
 * In Claude Code these live in a mix of textInputTypes.ts and a separate
 * messageQueueTypes.ts that ships only the operation log shapes. We
 * consolidate everything queue-related here so the import surface in
 * TM Code is one file.
 *
 * Adaptations from Claude Code:
 * - `value` is `string` only. Claude Code uses `string | ContentBlockParam[]`
 *   from the Anthropic SDK to support inline images in queue items. TM Code
 *   doesn't take that dependency at the queue layer — images live in the
 *   `attachments` field as `Attachment[]` and are resolved by the agent
 *   service at execution time, not at enqueue.
 * - `pastedContents` is `Attachment[]` (TM Code's existing attachment type)
 *   instead of `Record<number, PastedContent>`. Functionally equivalent:
 *   both are "raw inputs captured at paste time, materialised later".
 * - `agentId` is kept as a typed alias (`AgentId = string & { __brand }`)
 *   for forward compatibility with subagents, even though TM Code does not
 *   yet spawn subagents in-process.
 * - `MessageOrigin` is preserved structurally — TM Code currently only ever
 *   sets `kind: 'human'` (the implicit default) but the field is kept so
 *   future Remote Control / channel integrations can use it without
 *   re-touching the queue layer.
 * - `bridgeOrigin`, `workload`, `preExpansionValue`, `isMeta`, `orphanedPermission`
 *   are kept as optional fields. They are not produced by current TM Code
 *   call sites but are part of the contract Claude Code defines, and
 *   keeping them avoids divergence the next time the source is sync'd.
 */

import type { Attachment } from './chat'

// === Branded AgentId (placeholder for future subagents) ===

export type AgentId = string & { readonly __brand: 'AgentId' }

export function asAgentId(id: string): AgentId {
  return id as AgentId
}

// === Message origin (provenance) ===

/**
 * Provenance of a queued command. Stamped onto the resulting user message
 * so the transcript records origin structurally rather than via inline tags.
 *
 * Mirrors Claude Code's MessageOrigin (types/message.ts) — kept loose so
 * future Remote Control / channel integrations slot in without breaking
 * the queue layer.
 */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'channel'; channelId: string }
  | { kind: 'bridge'; clientId?: string }
  | { kind: 'remote'; source: string }
  | { kind: 'system'; reason: string }

// === Prompt input modes ===

/**
 * Input modes for the prompt.
 *
 * - `prompt` — normal user message (default).
 * - `bash` — shell-mode command (`!cmd`); processed one-at-a-time so each
 *   gets its own exit code and progress UI.
 * - `orphaned-permission` — a permission decision that arrived after the
 *   tool that requested it was already aborted. Replayed against the next
 *   matching tool call.
 * - `task-notification` — system-generated notification from a background
 *   task (e.g. "subagent X finished"). Non-editable from the user's input.
 */
export type PromptInputMode =
  | 'bash'
  | 'prompt'
  | 'orphaned-permission'
  | 'task-notification'

export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>

// === Queue priority ===

/**
 * Queue priority levels.
 *
 *  - `now`   — Interrupt and send immediately. Aborts any in-flight tool
 *              call (equivalent to Esc + send). Consumers subscribe to
 *              queue changes and abort when they see a 'now' command.
 *  - `next`  — Mid-turn drain. Let the current tool call finish, then
 *              send between the tool result and the next API round-trip.
 *  - `later` — End-of-turn drain. Wait for the current turn to finish,
 *              then process as a new query.
 *
 * In TM Code today the agent loop only supports between-turn drain so
 * `now` and `next` collapse to the same behaviour as `later`. The
 * priority field is still respected for ordering — `now` items are
 * dequeued first.
 */
export type QueuePriority = 'now' | 'next' | 'later'

// === Pasted content (placeholder) ===

/**
 * Claude Code carries a `Record<number, PastedContent>` to preserve image
 * IDs across the prompt → image-store round trip. TM Code's attachments
 * already carry their own ids and base64 data, so we use the existing
 * Attachment type directly. Kept as a separate alias for parity with the
 * source.
 */
export type QueuedPastedContent = Attachment

// === Orphaned permission (placeholder shape) ===

/**
 * Permission decisions that survive a cancelled tool call. The full
 * Claude Code shape carries `permissionResult` + `assistantMessage`; TM
 * Code does not yet have a permission queueing model so this is exported
 * as `unknown` for forward compatibility.
 */
export type OrphanedPermission = {
  permissionResult: unknown
  assistantMessage: unknown
}

// === Queued command ===

export type QueuedCommand = {
  /** The user's text. Plain string in TM Code (see file header). */
  value: string

  /** What kind of input this is — drives downstream routing. */
  mode: PromptInputMode

  /** Defaults to the priority implied by `mode` when enqueued. */
  priority?: QueuePriority

  /** Stable id, useful for `remove(id)` and React keys. */
  uuid?: string

  /** Set when this is an orphaned-permission replay. */
  orphanedPermission?: OrphanedPermission

  /**
   * Raw attachments captured at enqueue time. Resolved (read from disk,
   * embedded as base64) at execution time so the model sees inline images.
   */
  pastedContents?: QueuedPastedContent[]

  /**
   * The input string before any `[Pasted text #N]` placeholder expansion.
   * Falls back to `value` when unset. Reserved for future paste-expansion
   * support; currently unused in TM Code.
   */
  preExpansionValue?: string

  /**
   * When true, the input is treated as plain text even if it starts with
   * `/`. Used for remotely-received messages that should not trigger
   * local slash commands.
   */
  skipSlashCommands?: boolean

  /**
   * When true, slash commands are dispatched but filtered through a
   * "bridge-safe" allowlist — commands that pop local pickers (e.g.
   * /model) return a helpful error instead. Reserved.
   */
  bridgeOrigin?: boolean

  /**
   * When true, the resulting user message is hidden from the transcript
   * UI but still visible to the model. Used for system-generated prompts.
   */
  isMeta?: boolean

  /** Provenance — see MessageOrigin. */
  origin?: MessageOrigin

  /**
   * Workload tag threaded through to billing attribution. Set by cron /
   * scheduled triggers; rides the QueuedCommand so it's only hoisted into
   * bootstrap state when THIS command is dequeued.
   */
  workload?: string

  /**
   * Agent that should receive this notification. `undefined` = main thread.
   * The drain gate filters by this field so a subagent's task notifications
   * don't leak into the coordinator's context.
   */
  agentId?: AgentId
}

// === Operation log (persistence) ===

/**
 * Discrete queue operations. Recorded to disk so the queue's history can
 * be reconstructed for debugging and audit.
 */
export type QueueOperation = 'enqueue' | 'dequeue' | 'popAll' | 'remove'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /** Captured for `enqueue` and `popAll` ops when value is a string. */
  content?: string
}
