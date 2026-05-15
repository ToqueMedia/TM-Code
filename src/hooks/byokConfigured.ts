/**
 * Pure-function `computeByokConfigured` extracted from useByokState so the
 * boolean logic is testable without dragging Zustand / React / Firebase
 * imports through the hook chain. Both the hook (`useByokState`) and the
 * snapshot variant (`getByokStateSnapshot`) delegate here.
 *
 * The rule itself: "BYOK is locally configured" iff either the active
 * session was created with a snapshot, OR the global byokStore has all
 * three of (enabled, activeProvider, activeModel) set. Previously the
 * rule was duplicated inline across 5 sites and drifted between them.
 */

export interface ByokConfiguredInputs {
  sessionSnapshot: unknown | null
  enabled: boolean
  activeProvider: string | null
  activeModel: string | null
}

export function computeByokConfigured(input: ByokConfiguredInputs): boolean {
  return (
    input.sessionSnapshot !== null
    || (input.enabled && input.activeProvider !== null && input.activeModel !== null)
  )
}
