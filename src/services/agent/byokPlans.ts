/**
 * Pure plan-classification helper for BYOK routing. Standalone (no store /
 * Tauri / firebase imports) so it's unit-testable without the import.meta.env
 * chain that byokStore pulls in — same pattern as byokBaseURL.ts.
 */

// Plans WITH a paid TM budget. On these, BYOK uses the user's key for CODING
// only; auxiliaries + sidecars keep running on TM infra (the worker). On free
// plans, BYOK is fully self-funded — auxiliaries route through the user's key
// and sidecars are disabled. Unknown plans default to free (fail-safe: never
// bill TM infra for an unrecognised plan under BYOK).
const PAID_PLANS = new Set(['vibe', 'pro', 'max'])

export function isFreePlan(plan: string): boolean {
  return !PAID_PLANS.has(plan)
}
