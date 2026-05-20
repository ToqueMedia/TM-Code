/**
 * Per-session tracker of memory writes performed by the main agent.
 *
 * Why this exists: the post-turn auto-extractor (memoryExtractor.ts)
 * fires after every assistant turn and proposes memories the agent
 * "missed". When the agent itself already called `save_memory` during
 * the turn, the extractor's proposals tend to duplicate or contradict
 * what the agent already persisted — net result is noise in the
 * proposals working set and wasted side-car model spend.
 *
 * Ported pattern from claude-vaz (`hasMemoryWritesSince`,
 * services/extractMemories/extractMemories.ts:348-360): if the main
 * agent wrote memory at any point since the current turn started,
 * skip the extractor pass entirely — the agent's noticing discipline
 * is the source of truth this turn.
 *
 * Lifecycle:
 *   - `markTurnStart(sessionId)` resets the timestamp for the turn.
 *   - `recordMemoryWrite(sessionId)` is called from `save_memory` /
 *     `forget_memory` execute handlers on success.
 *   - `hasMemoryWriteSinceTurnStart(sessionId)` is called by the
 *     extractor; returns true if any write happened since
 *     `markTurnStart`.
 *
 * Module-level state — single-IDE-process scope. Survives across
 * turns within a session but resets each turn start. No persistence
 * needed; the signal is purely "did this turn already produce a
 * write".
 */

interface TurnState {
  /** Timestamp set by `markTurnStart`. */
  turnStartMs: number
  /** Timestamp of the most recent write in this session. */
  lastWriteMs: number
}

const state = new Map<string, TurnState>()

/**
 * Reset the turn-start timestamp for a session. Call this at the very
 * top of `runConversation` so each new turn starts with a clean window.
 */
export function markTurnStart(sessionId: string): void {
  const existing = state.get(sessionId)
  state.set(sessionId, {
    turnStartMs: Date.now(),
    lastWriteMs: existing?.lastWriteMs ?? 0,
  })
}

/**
 * Record that the main agent persisted a memory in this turn. Bumps
 * the session's `lastWriteMs`. Called from `save_memory` after the
 * topic file is written successfully.
 *
 * Idempotent — multiple writes in the same turn collapse to the
 * latest timestamp.
 */
export function recordMemoryWrite(sessionId: string): void {
  const existing = state.get(sessionId)
  state.set(sessionId, {
    turnStartMs: existing?.turnStartMs ?? 0,
    lastWriteMs: Date.now(),
  })
}

/**
 * True iff a memory write happened in this session since `markTurnStart`
 * was last called. Sessions without a recorded turn start return false
 * (no signal either way — extractor proceeds with its other gates).
 */
export function hasMemoryWriteSinceTurnStart(sessionId: string): boolean {
  const s = state.get(sessionId)
  if (!s || s.turnStartMs === 0) return false
  return s.lastWriteMs > s.turnStartMs
}

/** Test helper — clear all session state. */
export function __resetMemoryWriteTrackerForTests(): void {
  state.clear()
}
