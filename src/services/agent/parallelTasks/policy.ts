/**
 * Parallel / multi-window concurrency policy (F3).
 *
 * Authoritative product rule — keep ARCHITECTURE.md "Current parallel model"
 * in sync when changing these flags.
 *
 * ONE_AGENT_PER_PROJECT = true means:
 *  - at most one live agent run per project path (main loop or session runner);
 *  - addParallelTask always refuses;
 *  - a second spawn on a busy project steers the existing run when possible;
 *  - send_agent_message is disabled (no peer agent bus);
 *  - multi-window parallel work = different projects in different processes.
 *
 * Set false only with an explicit product decision to re-enable worktree fan-out
 * and peer messaging (and update ARCHITECTURE + prompts + tests together).
 */

/** F3: refuse concurrent agents on the same project path. */
export const ONE_AGENT_PER_PROJECT = true as const

/** User-facing / tool error copy (English). i18n keys: parallel.oneAgentPerProject* */
export const ONE_AGENT_PER_PROJECT_TOOL_ERROR =
  'Only one agent runs per project. Coordinate via the developer, not peer agents. Steer the live run or wait for it to finish.'

/** Throws if the flag was flipped without updating product docs. */
export function assertOneAgentPolicyActive(): void {
  if (!ONE_AGENT_PER_PROJECT) {
    throw new Error('ONE_AGENT_PER_PROJECT unexpectedly false — update ARCHITECTURE.md Current parallel model')
  }
}
