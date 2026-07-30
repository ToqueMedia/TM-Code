import {
  createBudgetTracker,
  checkTokenBudget,
  buildBudgetContinuationMessage,
} from "../tokenBudget";

describe("tokenBudget", () => {
  it("should create initial budget tracker state", () => {
    const tracker = createBudgetTracker();
    expect(tracker.continuationCount).toBe(0);
    expect(tracker.lastDeltaTokens).toBe(0);
    expect(tracker.lastGlobalTurnTokens).toBe(0);
    expect(tracker.startedAt).toBeGreaterThan(0);
  });

  it("should stop if budget is null or 0 or agentId is provided", () => {
    const tracker = createBudgetTracker();

    expect(checkTokenBudget(tracker, "sub-agent-1", 10000, 1000)).toEqual({
      action: "stop",
      completionEvent: null,
    });

    expect(checkTokenBudget(tracker, undefined, null, 1000)).toEqual({
      action: "stop",
      completionEvent: null,
    });

    expect(checkTokenBudget(tracker, undefined, 0, 1000)).toEqual({
      action: "stop",
      completionEvent: null,
    });
  });

  it("should decision continue when below threshold", () => {
    const tracker = createBudgetTracker();
    const budget = 10000;

    const result = checkTokenBudget(tracker, undefined, budget, 5000);
    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.continuationCount).toBe(1);
      expect(result.pct).toBe(50);
      expect(result.turnTokens).toBe(5000);
      expect(result.nudgeMessage).toContain("50% of the 10000 budget");
    }
  });

  it("should detect diminishing returns after 3 continuations with small deltas", () => {
    const tracker = createBudgetTracker();
    const budget = 100000;

    // Continuation 1
    checkTokenBudget(tracker, undefined, budget, 10000);
    // Continuation 2
    checkTokenBudget(tracker, undefined, budget, 10200);
    // Continuation 3
    checkTokenBudget(tracker, undefined, budget, 10400);

    // 4th check with delta < 500
    const result = checkTokenBudget(tracker, undefined, budget, 10600);
    expect(result.action).toBe("stop");
    if (result.action === "stop" && result.completionEvent) {
      expect(result.completionEvent.diminishingReturns).toBe(true);
    }
  });

  it("should format continuation message cleanly", () => {
    const msg = buildBudgetContinuationMessage(75, 7500, 10000);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("7500 tokens (75% of the 10000 budget)");
  });
});
