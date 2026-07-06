/**
 * Turn-efficiency measurement — infers WHY the agent loop continued past the
 * 3-4-request efficiency target for localized fixes.
 *
 * WHY THIS EXISTS
 * ─────────────
 * A simple bugfix that burns 7 provider round-trips without a technical reason
 * is a defect, not thoroughness. But the loop must NEVER block on turn count
 * alone — sometimes you genuinely need 6 turns (build cascade, tool failure,
 * discovered dependency). This module infers the continuation reason from what
 * actually happened in the turn so the loop can LOG it for debugging without
 * hard-blocking.
 *
 * DESIGN: structural signals only, no text/regex matching
 * ────────────────────────────────────────────────────────
 * The inference uses ONLY two structural facts the loop already knows:
 *   1. Which tools were called (by name — a stable enum, not free text).
 *   2. Whether each result flagged `isError: true` (a boolean the toolExecutor
 *      sets deterministically — exit code ≠ 0 for execute_command, exception
 *      thrown for others).
 *
 * It deliberately does NOT parse the result text for keywords like "error" or
 * "failed". Keyword matching is a gambiarra: compiler/linter/test-runner output
 * formats vary across providers and languages, new error phrasings silently
 * produce false negatives ("timeout", "segfault", "permission denied"), and
 * the keyword list rots without a test catching it. The `isError` boolean is
 * the toolExecutor's authoritative signal — it already did the work of
 * deciding whether the command failed; re-deriving that from text duplicates
 * the decision with a worse algorithm.
 *
 * The inferred reason is surfaced in two places:
 *   1. console.debug in query.ts when turnCount exceeds the target.
 *   2. The PayloadReport's `continuationReason` field (shown in the
 *      payload-inspector log + session export).
 *
 * Pure function — no imports beyond types — so it's unit-testable in isolation.
 */

/** Minimal snapshot of what happened in one turn. */
export interface TurnSnapshot {
  /** Tools the model called this turn (name only — args are irrelevant here). */
  toolCalls: ReadonlyArray<{ name: string }>
  /** Results of those tool calls. */
  toolResults: ReadonlyArray<{ content: string; isError: boolean }>
}

/** The efficiency target for localized fixes (guidance, not a hard limit). */
export const EFFICIENCY_TARGET_TURNS = 4

/** Tool names that indicate information-gathering (insufficient context). */
const READ_TOOLS = new Set([
  'read_file', 'read_around', 'search_files', 'glob', 'list_directory', 'read_large_result',
  'Read', 'Grep', 'Glob', 'LS',
  'read_skill', 'read_dev_server_logs',
])

/** Tool names that produce file edits. */
const EDIT_TOOLS = new Set([
  'edit_file', 'write_file', 'create_file',
])

/**
 * Infer the technical reason the loop continued past the efficiency target.
 *
 * Uses ONLY structural signals (tool names + isError booleans). The order
 * matters: a tool failure is classified by WHICH tool failed (edit vs command
 * vs other), not by parsing its output text. The fallback "no clear technical
 * reason" is the signal that the agent is likely over-working a simple task.
 */
export function inferContinuationReason(snapshot: TurnSnapshot): string {
  const { toolCalls, toolResults } = snapshot
  const toolNames = toolCalls.map((tc) => tc.name)

  // 1. Tool failure — any result flagged as error. Classify by WHICH tool
  //    errored, using only the tool name (structural), not the result text.
  const hasError = toolResults.some((r) => r.isError)
  if (hasError) {
    if (toolNames.includes('execute_command')) {
      return 'build/test/command error — fixing cascade'
    }
    if (toolNames.some((n) => EDIT_TOOLS.has(n))) {
      return 'edit failed — retrying with corrected content'
    }
    return 'tool failure — recovering'
  }

  // 2. Successful command run — the agent ran a build/test/lint and it
  //    passed (isError would have been true above if it hadn't).
  if (toolNames.includes('execute_command')) {
    return 'verifying via command'
  }

  // 3. Insufficient context — the turn was spent reading/gathering info.
  if (toolNames.some((n) => READ_TOOLS.has(n))) {
    return 'insufficient context — gathering information'
  }

  // 4. Ambiguity — the agent asked the developer a question.
  if (toolNames.includes('ask_user_question')) {
    return 'ambiguity — clarifying with developer'
  }

  // 5. Sub-agent dispatched — delegate/collect_results.
  if (toolNames.includes('delegate') || toolNames.includes('collect_results')) {
    return 'sub-agent dispatched — collecting results'
  }

  // 6. Provisioning — auth/database/files/deploy setup.
  if (toolNames.some((n) => n.startsWith('provision_'))) {
    return 'platform provisioning — setting up infrastructure'
  }

  // 7. No tool calls at all (continuation via steering/max_tokens) — unusual
  //    past the target; flag as no clear reason.
  if (toolCalls.length === 0) {
    return 'no tool calls — continued via steering or max_tokens recovery'
  }

  // Fallback: the turn produced tool calls but none fit a recognized
  // continuation pattern. This is the "consider wrapping up" signal.
  return 'no clear technical reason — consider wrapping up'
}

/**
 * True when the reason represents a legitimate technical continuation
 * (as opposed to the "no clear reason" fallback). Used by the caller to
 * decide warning severity.
 */
export function isLegitimateContinuationReason(reason: string): boolean {
  return !reason.startsWith('no clear technical reason') &&
    !reason.startsWith('no tool calls')
}
