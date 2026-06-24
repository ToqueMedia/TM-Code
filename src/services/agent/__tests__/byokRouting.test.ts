/**
 * Phase 2 free/paid boundary — isFreePlan decides who pays for auxiliary model
 * calls under BYOK: free → user's key, paid → TM infra. Locking it down so the
 * policy can't silently drift (a wrong classification = wrong carrier billed).
 */
import { isFreePlan } from '../byokPlans'

describe('isFreePlan', () => {
  it('classifies paid plans (TM infra for auxiliaries)', () => {
    expect(isFreePlan('vibe')).toBe(false)
    expect(isFreePlan('pro')).toBe(false)
    expect(isFreePlan('max')).toBe(false)
  })

  it('classifies free / no-budget plans (self-funded under BYOK)', () => {
    expect(isFreePlan('explorer')).toBe(true)
    expect(isFreePlan('welcome')).toBe(true)
    expect(isFreePlan('byok-only')).toBe(true)
    // Unknown/未来 plans default to free (fail-safe: never bill TM infra for an
    // unrecognised plan under BYOK).
    expect(isFreePlan('something-new')).toBe(true)
  })
})
