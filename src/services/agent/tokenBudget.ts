/**
 * Token budget tracker — ported from claude-vaz query/tokenBudget.ts.
 *
 * Tracks cumulative token consumption during a run and provides structural
 * decisions on whether to continue, nudge, or stop execution based on
 * budget thresholds and diminishing returns detection.
 */

const COMPLETION_THRESHOLD = 0.9;
const DIMINISHING_THRESHOLD = 500;

export interface BudgetTracker {
  continuationCount: number;
  lastDeltaTokens: number;
  lastGlobalTurnTokens: number;
  startedAt: number;
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  };
}

export interface ContinueDecision {
  action: "continue";
  nudgeMessage: string;
  continuationCount: number;
  pct: number;
  turnTokens: number;
  budget: number;
}

export interface StopDecision {
  action: "stop";
  completionEvent: {
    continuationCount: number;
    pct: number;
    turnTokens: number;
    budget: number;
    diminishingReturns: boolean;
    durationMs: number;
  } | null;
}

export type TokenBudgetDecision = ContinueDecision | StopDecision;

export function buildBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  return `<system-reminder>
Token budget update: current run has used ${turnTokens} tokens (${pct}% of the ${budget} budget). If the core objective has been achieved, wrap up and deliver your response. If additional steps are necessary, proceed with focus. This is an automated structural signal.
</system-reminder>`;
}

export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  // Sub-agents or unconstrained runs bypass token budget checks
  if (agentId || budget === null || budget <= 0) {
    return { action: "stop", completionEvent: null };
  }

  const turnTokens = globalTurnTokens;
  const pct = Math.round((turnTokens / budget) * 100);
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens;

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD;

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++;
    tracker.lastDeltaTokens = deltaSinceLastCheck;
    tracker.lastGlobalTurnTokens = globalTurnTokens;
    return {
      action: "continue",
      nudgeMessage: buildBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    };
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: "stop",
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    };
  }

  return { action: "stop", completionEvent: null };
}
