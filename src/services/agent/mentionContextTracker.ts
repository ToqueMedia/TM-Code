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
  /** True when the FULL outline was sent this turn; false when only the
   *  short reference stub was sent (follow-up turns). */
  mentionContextSentFullThisTurn: boolean
  /** Stable id for the mention context block, so the export can correlate
   *  the stub reference back to the turn that carried the full outline. */
  mentionContextRefId: string | undefined
}

let stats: MentionContextStats = {
  mentionContextRepeatedTokens: 0,
  mentionContextSentFullThisTurn: false,
  mentionContextRefId: undefined,
}

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
  stats.mentionContextSentFullThisTurn = true
  stats.mentionContextRefId = stats.mentionContextRefId ?? refId
  // Touch fullBody so the roughTokens helper is referenced (keeps the
  // estimator consistent if we later want to log full-body token count).
  void roughTokens(fullBody)
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
  stats.mentionContextRepeatedTokens += Math.max(
    0,
    roughTokens(fullBody) - roughTokens(stub),
  )
  stats.mentionContextRefId = stats.mentionContextRefId ?? refId
}

/** Read + reset the mention-context stats for this turn's export. */
export function getAndResetMentionContextStats(): MentionContextStats {
  const out = stats
  stats = {
    mentionContextRepeatedTokens: 0,
    mentionContextSentFullThisTurn: false,
    mentionContextRefId: undefined,
  }
  return out
}

/** Clear all stats. Called on session reset. */
export function clearMentionContextTracker(): void {
  stats = {
    mentionContextRepeatedTokens: 0,
    mentionContextSentFullThisTurn: false,
    mentionContextRefId: undefined,
  }
}
