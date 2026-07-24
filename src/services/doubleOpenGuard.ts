/**
 * Double-open guard policy: warn vs hard-block (Pacote 3).
 * Pure decision helper — openProject wires UI; this keeps the policy unit-tested.
 */

export type DoubleOpenDecision = 'allow' | 'confirm' | 'hard_block'

/** What openProject should do when another window holds a fresh lock. */
export function doubleOpenDecision(hardBlock: boolean, openElsewhere: boolean): DoubleOpenDecision {
  if (!openElsewhere) return 'allow'
  return hardBlock ? 'hard_block' : 'confirm'
}
