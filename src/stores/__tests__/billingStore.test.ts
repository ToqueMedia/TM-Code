import { useBillingStore, isBlocked, isInOverage, type MeResponse } from '../billingStore'

beforeEach(() => {
  useBillingStore.getState().reset()
})

describe('billingStore', () => {
  describe('initial state', () => {
    it('defaults to explorer plan and loaded=false', () => {
      const state = useBillingStore.getState()
      expect(state.plan).toBe('explorer')
      expect(state.isLoaded).toBe(false)
      expect(state.consumedPct).toBe(0)
      expect(state.tokensConsumed).toBe(0)
      expect(state.tokenBudget).toBe(0)
      expect(state.cycleEnd).toBe('')
      expect(state.status).toBe('allowed')
      expect(state.tmsRemaining).toBe(0)
      expect(state.noCredits).toBe(false)
    })
  })

  describe('updateFromMe', () => {
    it('bootstraps from /v1/me payload', () => {
      const me: MeResponse = {
        plan: 'pro',
        isActive: true,
        billing: {
          consumedPct: 0.42,
          tokensConsumed: 4_080_000,
          tokenBudget: 9_716_494,
          cycleEnd: '2026-04-30',
          extraUsageBalance: 3,
          status: 'allowed',
        },
      }
      useBillingStore.getState().updateFromMe(me)
      const state = useBillingStore.getState()
      expect(state.plan).toBe('pro')
      expect(state.isActive).toBe(true)
      expect(state.isLoaded).toBe(true)
      expect(state.consumedPct).toBeCloseTo(0.42, 4)
      expect(state.tokensConsumed).toBe(4_080_000)
      expect(state.tokenBudget).toBe(9_716_494)
      expect(state.cycleEnd).toBe('2026-04-30')
      expect(state.tmsRemaining).toBe(3)
      expect(state.status).toBe('allowed')
      expect(state.noCredits).toBe(false)
    })

    it('sets noCredits when status=rejected', () => {
      useBillingStore.getState().updateFromMe({
        plan: 'pro',
        isActive: true,
        billing: {
          consumedPct: 1.05,
          tokensConsumed: 10_200_000,
          tokenBudget: 9_716_494,
          cycleEnd: '2026-04-30',
          extraUsageBalance: 0,
          status: 'rejected',
        },
      })
      expect(useBillingStore.getState().noCredits).toBe(true)
    })
  })

  describe('updateFromHeaders', () => {
    it('applies billing headers from a chat response', () => {
      const headers = new Headers({
        'X-Budget-Pct': '0.72',
        'X-Budget-Status': 'allowed',
        'X-Cycle-End': '2026-04-30',
        'X-Extra-Tokens': '5',
        'X-Plan': 'max',
      })
      useBillingStore.getState().updateFromHeaders(headers)
      const state = useBillingStore.getState()
      expect(state.consumedPct).toBeCloseTo(0.72, 4)
      expect(state.status).toBe('allowed')
      expect(state.cycleEnd).toBe('2026-04-30')
      expect(state.tmsRemaining).toBe(5)
      expect(state.plan).toBe('max')
    })

    it('sets noCredits when X-Budget-Status=rejected', () => {
      const headers = new Headers({ 'X-Budget-Status': 'rejected' })
      useBillingStore.getState().updateFromHeaders(headers)
      expect(useBillingStore.getState().noCredits).toBe(true)
    })

    it('ignores missing headers gracefully', () => {
      const before = useBillingStore.getState()
      useBillingStore.getState().updateFromHeaders(new Headers({}))
      const after = useBillingStore.getState()
      expect(after.consumedPct).toBe(before.consumedPct)
      expect(after.tmsRemaining).toBe(before.tmsRemaining)
    })
  })

  describe('isBlocked / isInOverage helpers', () => {
    it('isBlocked returns true only for rejected', () => {
      expect(isBlocked('rejected')).toBe(true)
      expect(isBlocked('allowed_overage')).toBe(false)
      expect(isBlocked('allowed_warning')).toBe(false)
      expect(isBlocked('allowed')).toBe(false)
    })

    it('isInOverage returns true only for allowed_overage', () => {
      expect(isInOverage('allowed_overage')).toBe(true)
      expect(isInOverage('rejected')).toBe(false)
      expect(isInOverage('allowed_critical')).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears all state on logout', () => {
      useBillingStore.setState({
        plan: 'max',
        consumedPct: 0.9,
        tmsRemaining: 50,
        isLoaded: true,
      })
      useBillingStore.getState().reset()
      const state = useBillingStore.getState()
      expect(state.plan).toBe('explorer')
      expect(state.consumedPct).toBe(0)
      expect(state.tmsRemaining).toBe(0)
      expect(state.isLoaded).toBe(false)
    })
  })
})
