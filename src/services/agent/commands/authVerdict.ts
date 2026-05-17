/**
 * Pure utilities for the auth-flow verifier — extracted from
 * `verifyAuthFlow.ts` so they can be unit-tested without dragging in the
 * IDE's store layer (chatStore → byokStore → FirebaseAuthService, which
 * pulls Vite-only `import.meta.env` and breaks Jest).
 *
 * Keeping this file zero-dependency is the contract — if you need
 * anything from a store, a Tauri invoke, or a runtime service, it goes
 * in `verifyAuthFlow.ts`, not here.
 */

export type AuthVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

/**
 * Extract the trailing `VERDICT: PASS/FAIL/PARTIAL` line. Tolerant of
 * minor formatting drift (markdown bold, surrounding whitespace, case) but
 * the literal `VERDICT` keyword is required — same contract as the
 * claude-vaz verificationAgent.
 *
 * Returns 'PARTIAL' when no verdict line is present so the caller
 * surfaces the missing-verdict case as "couldn't verify" rather than
 * silently passing or treating it as a failure to fix.
 *
 * NB: currently matches the FIRST verdict line in the report — see the
 * test "matches the LAST verdict line" for the documented behaviour
 * around models that emit multiple verdict-shaped strings.
 */
export function parseVerdict(report: string): AuthVerdict {
  const match = report.match(/VERDICT[:\s]*\**\s*(PASS|FAIL|PARTIAL)\**/i)
  if (!match) return 'PARTIAL'
  const v = match[1].toUpperCase()
  if (v === 'PASS' || v === 'FAIL' || v === 'PARTIAL') return v
  return 'PARTIAL'
}
