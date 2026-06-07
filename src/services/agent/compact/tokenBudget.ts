/**
 * Token budget tracker — continuation/stop/diminishing-returns decisions.
 *
 * Ported from claude-vaz query/tokenBudget.ts, adapted for TM Code.
 *
 * Tracks per-turn token consumption against the user's billing budget
 * and decides whether the agent should continue working or stop.
 *
 * Decisions:
 *   - continue: below 90% of budget, still productive
 *   - stop (diminishing returns): 3+ continuations with <500 token deltas
 *   - stop (budget reached): at or above 90% of budget
 *   - stop (no budget): subagent or no budget configured
 */

// ── Constants ──

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

// ── Types ──

export interface BudgetTracker {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

export interface ContinueDecision {
  action: 'continue'
  nudgeMessage: string
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
}

export interface StopDecision {
  action: 'stop'
  completionEvent: {
    continuationCount: number
    pct: number
    turnTokens: number
    budget: number
    diminishingReturns: boolean
    durationMs: number
  } | null
}

export type TokenBudgetDecision = ContinueDecision | StopDecision

// ── Helpers ──

function getBudgetContinuationMessage(pct: number, turnTokens: number, budget: number): string {
  if (pct < 25) {
    return `You've used ${pct}% of the available token budget (${formatTokens(turnTokens)}/${formatTokens(budget)} tokens). Continue working on the task.`
  }
  if (pct < 50) {
    return `${pct}% of token budget used (${formatTokens(turnTokens)}/${formatTokens(budget)} tokens). You have plenty of room — continue working.`
  }
  if (pct < 75) {
    return `${pct}% of token budget used (${formatTokens(turnTokens)}/${formatTokens(budget)} tokens). Continue efficiently.`
  }
  return `${pct}% of token budget used (${formatTokens(turnTokens)}/${formatTokens(budget)} tokens). Budget is getting tight — focus on completing the most important remaining work.`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

// ── Core logic ──

/**
 * Check token budget and decide whether to continue or stop.
 *
 * @param tracker - Mutable budget tracker (updated in-place)
 * @param agentId - If set (subagent), always stop — subagents don't manage budget
 * @param budget - Total token budget for this session (null = unlimited)
 * @param globalTurnTokens - Current total token usage across all turns
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  // Subagents or no budget → always stop (no budget management)
  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }

  const turnTokens = globalTurnTokens
  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

  // Diminishing returns: 3+ continuations with small deltas
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = globalTurnTokens
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    }
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }

  return { action: 'stop', completionEvent: null }
}
