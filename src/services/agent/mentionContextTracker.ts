/**
 * Mention Context Tracker — telemetry for the follow-up-turn stub path.
 *
 * When a user @-mentions a large file, the first turn emits a full
 * compact_reference outline + preview (thousands of tokens). Every
 * SUBSEQUENT turn of the agent loop used to re-send that same body — pure
 * waste, since the model already has it in the conversation above.
 *
 * query.ts replaces the full body with a short reference stub in the final
 * provider payload on follow-up turns. This tracker records what was sent so the
 * request-usage export can prove the stub path fired and quantify the saving.
 *
 * Module-level singleton (same pattern as readRangeTracker) so the payload
 * compactor and request-usage export can share per-turn stats.
 */

interface MentionContextStats {
  /** Token saving this turn = (full body tokens) − (stub tokens actually
   *  sent). 0 when the full body was sent (first turn) or no mention. */
  mentionContextRepeatedTokens: number
  /** Cumulative saving across this session since the tracker was cleared. */
  mentionContextRepeatedTokensCumulative: number
  /** Estimated tokens of the full mention context this request refers to. */
  mentionContextFullTokens: number
  /** Estimated tokens of the stub actually sent in this request. */
  mentionContextStubTokens: number
  /** True when the FULL outline was sent this turn; false when only the
   *  short reference stub was sent (follow-up turns). */
  mentionContextSentFullThisTurn: boolean
  /** Stable id for the mention context block, so the export can correlate
   *  the stub reference back to the turn that carried the full outline. */
  mentionContextRefId: string | undefined
}

let stats: MentionContextStats = {
  mentionContextRepeatedTokens: 0,
  mentionContextRepeatedTokensCumulative: 0,
  mentionContextFullTokens: 0,
  mentionContextStubTokens: 0,
  mentionContextSentFullThisTurn: false,
  mentionContextRefId: undefined,
}

let cumulativeRepeatedTokens = 0

/** Rough token estimate matching payloadInspector's chars/3 heuristic. */
function roughTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/**
 * Called by the payload compactor when the FULL outline body is emitted
 * (first turn, or when the stub path doesn't apply). Records that the full
 * body was sent.
 */
export function recordMentionContextFull(refId: string, fullBody: string): void {
  const fullTokens = roughTokens(fullBody)
  stats.mentionContextSentFullThisTurn = true
  stats.mentionContextRefId = stats.mentionContextRefId ?? refId
  stats.mentionContextFullTokens += fullTokens
  stats.mentionContextRepeatedTokensCumulative = cumulativeRepeatedTokens
}

/**
 * Called by the payload compactor when the short reference stub is emitted
 * instead of the full body (follow-up turns). Records the stub and the token
 * saving vs re-sending the full body.
 */
export function recordMentionContextStub(
  refId: string,
  fullBody: string,
  stub: string,
): void {
  const fullTokens = roughTokens(fullBody)
  const stubTokens = roughTokens(stub)
  const saved = Math.max(0, fullTokens - stubTokens)
  stats.mentionContextRepeatedTokens += saved
  stats.mentionContextFullTokens += fullTokens
  stats.mentionContextStubTokens += stubTokens
  cumulativeRepeatedTokens += saved
  stats.mentionContextRepeatedTokensCumulative = cumulativeRepeatedTokens
  stats.mentionContextSentFullThisTurn = false
  stats.mentionContextRefId = stats.mentionContextRefId ?? refId
}

/** Read + reset the mention-context stats for this turn's export. */
export function getAndResetMentionContextStats(): MentionContextStats {
  const out = stats
  resetMentionContextTurnStats()
  return out
}

/** Clear only per-request fields, preserving the session cumulative counter. */
export function resetMentionContextTurnStats(): void {
  stats = {
    mentionContextRepeatedTokens: 0,
    mentionContextRepeatedTokensCumulative: cumulativeRepeatedTokens,
    mentionContextFullTokens: 0,
    mentionContextStubTokens: 0,
    mentionContextSentFullThisTurn: false,
    mentionContextRefId: undefined,
  }
}

/** Clear all stats. Called on session reset. */
export function clearMentionContextTracker(): void {
  stats = {
    mentionContextRepeatedTokens: 0,
    mentionContextRepeatedTokensCumulative: 0,
    mentionContextFullTokens: 0,
    mentionContextStubTokens: 0,
    mentionContextSentFullThisTurn: false,
    mentionContextRefId: undefined,
  }
  cumulativeRepeatedTokens = 0
}
