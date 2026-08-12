import { useBillingStore, isBlocked, isInOverage, isTeamCollabActive, persistBillingCache, getCachedBillingUid, type MeResponse } from '../billingStore'

beforeEach(() => {
  useBillingStore.getState().reset()
})

describe('isTeamCollabActive', () => {
  const future = new Date(Date.now() + 30 * 864e5).toISOString()
  const past = new Date(Date.now() - 864e5).toISOString()

  it('is false without a team membership', () => {
    expect(isTeamCollabActive({ teamMemberOf: null, planExpiresAt: future })).toBe(false)
  })
  it('is true for a member with a future expiry', () => {
    expect(isTeamCollabActive({ teamMemberOf: 'team-1', planExpiresAt: future })).toBe(true)
  })
  it('is true for a member when expiry is unknown (empty — old worker)', () => {
    expect(isTeamCollabActive({ teamMemberOf: 'team-1', planExpiresAt: '' })).toBe(true)
  })
  it('is FALSE once the term has lapsed (the v1.0.1 expiry requirement)', () => {
    expect(isTeamCollabActive({ teamMemberOf: 'team-1', planExpiresAt: past })).toBe(false)
  })
  it('ignores an unparseable expiry (stays permissive)', () => {
    expect(isTeamCollabActive({ teamMemberOf: 'team-1', planExpiresAt: 'not-a-date' })).toBe(true)
  })
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

    it('metering 30/70: headers novos na unidade do plano (µ$ nos pagos)', () => {
      const headers = new Headers({
        'X-Budget-Pct': '0.30',
        'X-Budget-Status': 'allowed',
        'X-Budget-Unit': 'micros',
        'X-Budget-Consumed': '2100000', // $2.10 de custo real
        'X-Extra-Balance': '500000',
        'X-Plan': 'vibe',
        'X-Team-Id': 'team-1',
        'X-Team-Tier': 'team-pro',
        'X-Team-Slice-Micros': '8750000',
        'X-Team-Pie-Micros': '17500000',
      })
      useBillingStore.getState().updateFromHeaders(headers)
      const state = useBillingStore.getState()
      expect(state.budgetUnit).toBe('micros')
      expect(state.tokensConsumed).toBe(2_100_000)
      expect(state.tmsRemaining).toBe(500_000)
      expect(state.team?.mySliceTokens).toBe(8_750_000)
      expect(state.team?.pieTotal).toBe(17_500_000)
      expect(state.team?.mySlicePct).toBeCloseTo(0.5, 4)
    })

    it('explorer mantém a unidade tokens (header + /v1/me sem unit)', () => {
      const headers = new Headers({
        'X-Budget-Unit': 'tokens',
        'X-Budget-Consumed': '1250000',
        'X-Plan': 'explorer',
      })
      useBillingStore.getState().updateFromHeaders(headers)
      const state = useBillingStore.getState()
      expect(state.budgetUnit).toBe('tokens')
      expect(state.tokensConsumed).toBe(1_250_000)
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

  describe('last-request stats (display-only)', () => {
    // A contabilidade de consumo é exclusiva do worker ai-pass-through —
    // o cliente NUNCA mexe em tokensConsumed/consumedPct localmente. O store
    // só acumula a stat de display do "último pedido".
    it('accumulates per-turn tokens without touching consumption state', () => {
      useBillingStore.getState().updateFromMe({
        plan: 'pro',
        isActive: true,
        billing: {
          consumedPct: 0.25,
          tokensConsumed: 250,
          tokenBudget: 1000,
          cycleEnd: '2026-04-30',
          extraUsageBalance: 0,
          status: 'allowed',
        },
      })

      useBillingStore.getState().addLastRequestTokens(125)
      useBillingStore.getState().addLastRequestTokens(75)

      const state = useBillingStore.getState()
      expect(state.lastTokensUsed).toBe(200)
      expect(state.tokensConsumed).toBe(250)       // intocado
      expect(state.consumedPct).toBeCloseTo(0.25, 4) // intocado
    })

    it('resetLastRequestStats zeroes the stat at the start of a new run', () => {
      useBillingStore.getState().addLastRequestTokens(500)
      useBillingStore.getState().resetLastRequestStats()
      expect(useBillingStore.getState().lastTokensUsed).toBe(0)
    })
  })

  describe('boot cache (arranque sem flash de plano)', () => {
    it('persistBillingCache + getCachedBillingUid round-trip', () => {
      useBillingStore.getState().updateFromMe({
        plan: 'max',
        isActive: true,
        billing: {
          consumedPct: 0.1,
          tokensConsumed: 12_000_000,
          tokenBudget: 129_810_000,
          cycleEnd: '2026-06-30',
          extraUsageBalance: 0,
          status: 'allowed',
        },
      })
      persistBillingCache('uid-abc')
      expect(getCachedBillingUid()).toBe('uid-abc')
      const raw = JSON.parse(localStorage.getItem('tm-billing-cache-v1')!)
      expect(raw.plan).toBe('max')
      expect(raw.tokensConsumed).toBe(12_000_000)
    })

    it('reset() (logout/troca de conta) apaga a cache', () => {
      persistBillingCache('uid-abc')
      useBillingStore.getState().reset()
      expect(getCachedBillingUid()).toBeNull()
      expect(localStorage.getItem('tm-billing-cache-v1')).toBeNull()
    })

    it('o boot hidrata a store a partir da cache (módulo isolado)', () => {
      localStorage.setItem('tm-billing-cache-v1', JSON.stringify({
        v: 1,
        uid: 'uid-cached',
        savedAt: Date.now(),
        plan: 'pro',
        isActive: true,
        consumedPct: 0.42,
        tokensConsumed: 8_800_000,
        tokenBudget: 20_910_000,
        cycleEnd: '2026-06-30',
        status: 'allowed',
        tmsRemaining: 100_000,
      }))
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../billingStore') as typeof import('../billingStore')
        const state = fresh.useBillingStore.getState()
        expect(state.plan).toBe('pro')
        expect(state.tokensConsumed).toBe(8_800_000)
        expect(state.consumedPct).toBeCloseTo(0.42, 4)
        // isLoaded continua false — o /v1/me desta sessão ainda não veio.
        expect(state.isLoaded).toBe(false)
      })
      localStorage.removeItem('tm-billing-cache-v1')
    })

    it('cache expirada (>7 dias) é ignorada no boot', () => {
      localStorage.setItem('tm-billing-cache-v1', JSON.stringify({
        v: 1,
        uid: 'uid-old',
        savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        plan: 'pro',
        isActive: true,
        consumedPct: 0.42,
        tokensConsumed: 8_800_000,
        tokenBudget: 20_910_000,
        cycleEnd: '2026-05-31',
        status: 'allowed',
        tmsRemaining: 0,
      }))
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../billingStore') as typeof import('../billingStore')
        expect(fresh.useBillingStore.getState().plan).toBe('explorer')
      })
      localStorage.removeItem('tm-billing-cache-v1')
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
