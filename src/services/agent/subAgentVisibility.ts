/**
 * Shared sub-agent visibility wiring.
 *
 * Keeps the "forward every sub-agent event into the user-facing chat message"
 * concerns in one place so research / verify / spawn_background_agent all get
 * identical behaviour:
 *   - Tool calls and results appear inline with `spawnedBy = parent tool id`
 *     (the UI renders them nested under the launcher).
 *   - Text and reasoning deltas stream into the same assistant message.
 *   - Reasoning is prefixed with a one-time `— {label} —` separator so the
 *     user can tell sub-agent thoughts apart from main-agent thoughts.
 *   - Any tool call that was still `running` when the sub-agent errors is
 *     marked failed on cleanup (no more orphans spinning forever in the UI).
 *   - Agent status ticks between 'generating' / 'thinking' / 'applying' as
 *     the sub-agent works, so the status bar reflects real activity instead
 *     of staying stuck on 'applying' for the whole run.
 *
 * Pure — takes all store/agent interactions as dependencies so the helper can
 * be unit-tested without importing chatStore / agentStore (both of which pull
 * Vite's `import.meta.env` into the Jest CJS transform and break suite load).
 */

export type SubAgentStatus = 'generating' | 'thinking' | 'applying'

export interface VisibilityHooks {
  appendTextDelta: (delta: string) => void
  appendReasoningDelta: (delta: string) => void
  addPendingToolCall: (
    toolId: string,
    toolName: string,
    spawnedBy?: string,
    targetMessageId?: string,
  ) => void
  updateToolCallWithArgs: (
    toolId: string,
    args: Record<string, unknown>,
    targetMessageId?: string,
  ) => void
  updateToolCallWithResult: (
    toolId: string,
    result: string,
    isError: boolean,
    targetMessageId?: string,
  ) => void
  setStatus?: (status: SubAgentStatus) => void
}

export interface SubAgentVisibilityOptions {
  /** The parent tool call id (e.g., the `research` / `verify` call). Child tool
   *  calls carry this as `spawnedBy` so the UI nests them visually. */
  parentToolCallId?: string
  /** Human-readable label inserted into the reasoning separator — e.g., 'research sub-agent'. */
  reasoningLabel: string
  /** Explicit message id for writes. Required for background agents that must
   *  keep updating the message after the main turn finalizes (streamingMessageId
   *  becomes null). Left undefined, writes follow the store's streamingMessageId. */
  targetMessageId?: string
  hooks: VisibilityHooks
}

export interface SubAgentVisibility {
  /** Inject into `runAgentLoop(..., visibility.callbacks)`. */
  callbacks: {
    onTextDelta: (delta: string) => void
    onReasoningDelta: (delta: string) => void
    onToolCallPending: (toolId: string, toolName: string) => void
    onToolCallStart: (toolId: string, toolName: string, args: Record<string, unknown>) => void
    onToolResult: (toolId: string, toolName: string, result: string, isError: boolean) => void
  }
  /** Call once from the sub-agent's onError handler (or the surrounding `.catch()`)
   *  to mark every tool call still in-flight as failed. Idempotent. */
  cleanupOrphans: (reason: string) => void
  /** Exposed for tests / debugging. */
  inFlightCount: () => number
}

export function createSubAgentVisibility(opts: SubAgentVisibilityOptions): SubAgentVisibility {
  const { parentToolCallId, reasoningLabel, targetMessageId, hooks } = opts
  const inFlightChildren = new Set<string>()
  let reasoningHeaderEmitted = false

  const setStatus = (s: SubAgentStatus) => { hooks.setStatus?.(s) }

  return {
    callbacks: {
      onTextDelta: (delta) => {
        hooks.appendTextDelta(delta)
        setStatus('generating')
      },
      onReasoningDelta: (delta) => {
        if (!reasoningHeaderEmitted) {
          hooks.appendReasoningDelta(`\n\n— ${reasoningLabel} —\n\n`)
          reasoningHeaderEmitted = true
        }
        hooks.appendReasoningDelta(delta)
        setStatus('thinking')
      },
      onToolCallPending: (toolId, toolName) => {
        if (parentToolCallId) {
          hooks.addPendingToolCall(toolId, toolName, parentToolCallId, targetMessageId)
        }
        inFlightChildren.add(toolId)
        setStatus('applying')
      },
      onToolCallStart: (toolId, _toolName, args) => {
        hooks.updateToolCallWithArgs(toolId, args, targetMessageId)
      },
      onToolResult: (toolId, _toolName, result, isError) => {
        hooks.updateToolCallWithResult(toolId, result, isError, targetMessageId)
        inFlightChildren.delete(toolId)
      },
    },
    cleanupOrphans: (reason: string) => {
      for (const orphanId of inFlightChildren) {
        hooks.updateToolCallWithResult(orphanId, reason, true, targetMessageId)
      }
      inFlightChildren.clear()
    },
    inFlightCount: () => inFlightChildren.size,
  }
}
