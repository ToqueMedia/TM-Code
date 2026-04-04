import { useBillingStore, getEffectiveUtilization } from '../billingStore'

beforeEach(() => {
  useBillingStore.getState().reset()
})

describe('billingStore', () => {
  describe('initial state', () => {
    it('defaults to explorer plan', () => {
      const state = useBillingStore.getState()
      expect(state.plan).toBe('explorer')
      expect(state.isLoaded).toBe(false)
      expect(state.creditsRemaining).toBeNull()
      expect(state.noCredits).toBe(false)
      expect(state.planCapacity).toBe(10)
    })
  })

  describe('updateFromSSE', () => {
    it('updates credits and plan from SSE billing event', () => {
      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 95,
        credits_used: 2,
        tokens_used: 25000,
        plan: 'pro',
        source: 'monthly',
      })

      const state = useBillingStore.getState()
      expect(state.creditsRemaining).toBe(95)
      expect(state.plan).toBe('pro')
      expect(state.lastCreditsUsed).toBe(2)
      expect(state.lastTokensUsed).toBe(25000)
      expect(state.lastSource).toBe('monthly')
      expect(state.noCredits).toBe(false)
    })

    it('sets noCredits when credits reach 0', () => {
      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 0,
        credits_used: 1,
        tokens_used: 5000,
        plan: 'explorer',
        source: 'daily',
      })

      expect(useBillingStore.getState().noCredits).toBe(true)
      expect(useBillingStore.getState().creditsRemaining).toBe(0)
    })

    it('preserves planCapacity (does not inflate)', () => {
      // Set initial capacity via setState (simulating /v1/me response)
      useBillingStore.setState({ planCapacity: 100 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 50,
        credits_used: 1,
        tokens_used: 1000,
        plan: 'pro',
        source: 'monthly',
      })

      // planCapacity should stay at 100, not change to 50
      expect(useBillingStore.getState().planCapacity).toBe(100)
    })

    it('falls back to current plan if SSE plan is empty', () => {
      useBillingStore.setState({ plan: 'business-8x' })

      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 700,
        credits_used: 1,
        tokens_used: 1000,
        plan: '',
        source: 'monthly',
      })

      expect(useBillingStore.getState().plan).toBe('business-8x')
    })
  })

  describe('updateFromHeaders', () => {
    it('updates plan from X-Plan header independently of credits', () => {
      const headers = new Headers({ 'X-Plan': 'business-4x' })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().plan).toBe('business-4x')
      // Credits not sent — should remain null
      expect(useBillingStore.getState().creditsRemaining).toBeNull()
    })

    it('updates both plan and credits when both headers present', () => {
      const headers = new Headers({
        'X-Plan': 'pro',
        'X-Credits-Remaining': '88',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      const state = useBillingStore.getState()
      expect(state.plan).toBe('pro')
      expect(state.creditsRemaining).toBe(88)
      expect(state.noCredits).toBe(false)
    })

    it('sets noCredits when credits header is 0', () => {
      const headers = new Headers({
        'X-Plan': 'explorer',
        'X-Credits-Remaining': '0',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().noCredits).toBe(true)
    })

    it('ignores invalid credits header', () => {
      useBillingStore.setState({ creditsRemaining: 50 })
      const headers = new Headers({ 'X-Credits-Remaining': 'NaN' })
      useBillingStore.getState().updateFromHeaders(headers)

      // Should not change
      expect(useBillingStore.getState().creditsRemaining).toBe(50)
    })

    it('does nothing when no relevant headers', () => {
      useBillingStore.setState({ plan: 'pro', creditsRemaining: 50 })
      const headers = new Headers({ 'Content-Type': 'application/json' })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().plan).toBe('pro')
      expect(useBillingStore.getState().creditsRemaining).toBe(50)
    })
  })

  describe('setNoCredits / clearNoCredits', () => {
    it('setNoCredits sets flag and zeroes credits', () => {
      useBillingStore.setState({ creditsRemaining: 5, noCredits: false })
      useBillingStore.getState().setNoCredits()

      expect(useBillingStore.getState().noCredits).toBe(true)
      expect(useBillingStore.getState().creditsRemaining).toBe(0)
    })

    it('clearNoCredits clears the flag', () => {
      useBillingStore.setState({ noCredits: true })
      useBillingStore.getState().clearNoCredits()

      expect(useBillingStore.getState().noCredits).toBe(false)
    })
  })

  describe('reset', () => {
    it('resets all state to defaults', () => {
      useBillingStore.setState({
        plan: 'business-8x',
        isLoaded: true,
        creditsRemaining: 500,
        planCapacity: 800,
        noCredits: false,
        lastCreditsUsed: 3,
        lastTokensUsed: 50000,
        lastSource: 'monthly',
      })

      useBillingStore.getState().reset()

      const state = useBillingStore.getState()
      expect(state.plan).toBe('explorer')
      expect(state.isLoaded).toBe(false)
      expect(state.creditsRemaining).toBeNull()
      expect(state.planCapacity).toBe(10)
      expect(state.noCredits).toBe(false)
      expect(state.lastCreditsUsed).toBe(0)
      expect(state.lastTokensUsed).toBe(0)
      expect(state.lastSource).toBe('')
    })
  })

  // ── Adversarial tests ──────────────────────────────────────────

  describe('adversarial: invalid plan from backend', () => {
    it('stores unknown plan string without crash', () => {
      const headers = new Headers({ 'X-Plan': 'team' })
      useBillingStore.getState().updateFromHeaders(headers)

      // Cast goes through — value is stored as-is
      expect(useBillingStore.getState().plan).toBe('team')
    })

    it('updateFromSSE with unknown plan keeps it', () => {
      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 50,
        credits_used: 1,
        tokens_used: 1000,
        plan: 'enterprise',
        source: 'monthly',
      })
      expect(useBillingStore.getState().plan).toBe('enterprise')
    })
  })

  describe('adversarial: real request sequence (headers → SSE)', () => {
    it('planCapacity stays stable across headers then SSE', () => {
      // Simulate /v1/me set capacity on login
      useBillingStore.setState({ planCapacity: 100, plan: 'pro', isLoaded: true })

      // 1. Headers arrive before stream (approximate credits)
      const headers = new Headers({
        'X-Plan': 'pro',
        'X-Credits-Remaining': '99',
      })
      useBillingStore.getState().updateFromHeaders(headers)
      expect(useBillingStore.getState().creditsRemaining).toBe(99)
      expect(useBillingStore.getState().planCapacity).toBe(100) // stable

      // 2. SSE arrives after stream (exact credits, post-token-extras)
      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 97,
        credits_used: 2,
        tokens_used: 30000,
        plan: 'pro',
        source: 'monthly',
      })
      expect(useBillingStore.getState().creditsRemaining).toBe(97)
      expect(useBillingStore.getState().planCapacity).toBe(100) // still stable
    })

    it('credits decrease correctly across multiple messages', () => {
      useBillingStore.setState({ planCapacity: 10, plan: 'explorer', isLoaded: true, creditsRemaining: 10 })

      // Message 1
      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 9, credits_used: 1, tokens_used: 5000, plan: 'explorer', source: 'daily',
      })
      expect(useBillingStore.getState().creditsRemaining).toBe(9)

      // Message 2
      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 7, credits_used: 2, tokens_used: 25000, plan: 'explorer', source: 'daily',
      })
      expect(useBillingStore.getState().creditsRemaining).toBe(7)
      expect(useBillingStore.getState().lastCreditsUsed).toBe(2)

      // Message 10 (last credit)
      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 0, credits_used: 1, tokens_used: 3000, plan: 'explorer', source: 'daily',
      })
      expect(useBillingStore.getState().creditsRemaining).toBe(0)
      expect(useBillingStore.getState().noCredits).toBe(true)
    })
  })

  describe('adversarial: negative and edge values', () => {
    it('handles credits_remaining: -1 from backend', () => {
      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: -1, credits_used: 1, tokens_used: 1000, plan: 'pro', source: 'monthly',
      })
      expect(useBillingStore.getState().creditsRemaining).toBe(-1)
      expect(useBillingStore.getState().noCredits).toBe(true)
    })

    it('handles X-Credits-Remaining: 0 string', () => {
      const headers = new Headers({ 'X-Credits-Remaining': '0' })
      useBillingStore.getState().updateFromHeaders(headers)
      expect(useBillingStore.getState().creditsRemaining).toBe(0)
      expect(useBillingStore.getState().noCredits).toBe(true)
    })

    it('handles very large credit values', () => {
      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 999999, credits_used: 1, tokens_used: 100, plan: 'business-8x', source: 'purchased',
      })
      expect(useBillingStore.getState().creditsRemaining).toBe(999999)
    })
  })

  // ── Envelope monotonic rules ────────────────────────────────────

  describe('envelope: monotonic utilization (SSE)', () => {
    it('never decreases utilization within same window', () => {
      useBillingStore.setState({ envelope5hUtilization: 0.6, envelope5hReset: 1000 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 90, credits_used: 1, tokens_used: 5000,
        plan: 'pro', source: 'monthly',
        envelope_5h_utilization: 0.3, // lower — should be rejected
        envelope_5h_reset: 1000,      // same window
      })

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.6) // unchanged
    })

    it('accepts higher utilization within same window', () => {
      useBillingStore.setState({ envelope5hUtilization: 0.3, envelope5hReset: 1000 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 90, credits_used: 1, tokens_used: 5000,
        plan: 'pro', source: 'monthly',
        envelope_5h_utilization: 0.6,
        envelope_5h_reset: 1000,
      })

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.6)
    })

    it('accepts new window utilization when reset epoch changes', () => {
      useBillingStore.setState({ envelope5hUtilization: 0.8, envelope5hReset: 1000 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 90, credits_used: 1, tokens_used: 5000,
        plan: 'pro', source: 'monthly',
        envelope_5h_utilization: 0.1, // new window — accept even though lower
        envelope_5h_reset: 2000,      // different epoch
      })

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.1)
      expect(useBillingStore.getState().envelope5hReset).toBe(2000)
    })

    it('rejects new window with util=0 when current > 0 (prevents flash-to-0%)', () => {
      useBillingStore.setState({ envelope5hUtilization: 0.5, envelope5hReset: 1000 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 90, credits_used: 1, tokens_used: 5000,
        plan: 'pro', source: 'monthly',
        envelope_5h_utilization: 0,   // zero in new window
        envelope_5h_reset: 2000,      // new window
      })

      // Should keep old value to prevent flash-to-0%
      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.5)
    })

    it('accepts new window with util=0 when current is already 0', () => {
      useBillingStore.setState({ envelope5hUtilization: 0, envelope5hReset: 1000 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 90, credits_used: 1, tokens_used: 5000,
        plan: 'pro', source: 'monthly',
        envelope_5h_utilization: 0,
        envelope_5h_reset: 2000,
      })

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0) // accepted
    })
  })

  describe('envelope: monotonic utilization (headers)', () => {
    it('never decreases 5h utilization within same window via headers', () => {
      useBillingStore.setState({ envelope5hUtilization: 0.7, envelope5hReset: 5000 })

      const headers = new Headers({
        'x-tm-ratelimit-5h-utilization': '0.4',
        'x-tm-ratelimit-5h-reset': '5000', // same window
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.7) // kept higher
    })

    it('accepts higher utilization via headers in same window', () => {
      useBillingStore.setState({ envelope5hUtilization: 0.3, envelope5hReset: 5000 })

      const headers = new Headers({
        'x-tm-ratelimit-5h-utilization': '0.9',
        'x-tm-ratelimit-5h-reset': '5000',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.9)
    })

    it('7d utilization follows same monotonic rule', () => {
      useBillingStore.setState({ envelope7dUtilization: 0.6, envelope7dReset: 9000 })

      const headers = new Headers({
        'x-tm-ratelimit-7d-utilization': '0.2',
        'x-tm-ratelimit-7d-reset': '9000',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().envelope7dUtilization).toBe(0.6) // unchanged
    })
  })

  describe('envelope: TMS monotonic (SSE)', () => {
    it('accepts TMS decrease (normal usage)', () => {
      useBillingStore.setState({ tmsRemaining: 50 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 48, credits_used: 2, tokens_used: 200000,
        plan: 'pro', source: 'monthly',
        tms_remaining: 48,
      })

      expect(useBillingStore.getState().tmsRemaining).toBe(48)
    })

    it('rejects TMS increase (stale read)', () => {
      useBillingStore.setState({ tmsRemaining: 50 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 52, credits_used: 0, tokens_used: 0,
        plan: 'pro', source: 'monthly',
        tms_remaining: 52, // only +2, not a purchase
      })

      expect(useBillingStore.getState().tmsRemaining).toBe(50) // kept lower
    })

    it('accepts significant TMS increase (purchase detected)', () => {
      useBillingStore.setState({ tmsRemaining: 50 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 150, credits_used: 0, tokens_used: 0,
        plan: 'pro', source: 'purchased',
        tms_remaining: 150, // +100 — clearly a purchase
      })

      expect(useBillingStore.getState().tmsRemaining).toBe(150)
    })

    it('accepts any TMS value when current is 0', () => {
      useBillingStore.setState({ tmsRemaining: 0 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 10, credits_used: 0, tokens_used: 0,
        plan: 'pro', source: 'monthly',
        tms_remaining: 10,
      })

      expect(useBillingStore.getState().tmsRemaining).toBe(10)
    })
  })

  describe('envelope: credits monotonic (SSE)', () => {
    it('accepts credit decrease (normal usage)', () => {
      useBillingStore.setState({ creditsRemaining: 100 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 98, credits_used: 2, tokens_used: 50000,
        plan: 'pro', source: 'monthly',
      })

      expect(useBillingStore.getState().creditsRemaining).toBe(98)
    })

    it('rejects small credit increase (stale read)', () => {
      useBillingStore.setState({ creditsRemaining: 50 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 52, credits_used: 0, tokens_used: 0,
        plan: 'pro', source: 'monthly',
      })

      expect(useBillingStore.getState().creditsRemaining).toBe(50) // Math.min
    })

    it('accepts large credit increase (purchase)', () => {
      useBillingStore.setState({ creditsRemaining: 50 })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 200, credits_used: 0, tokens_used: 0,
        plan: 'pro', source: 'purchased',
      })

      expect(useBillingStore.getState().creditsRemaining).toBe(200)
    })
  })

  // ── usingTmsOverage derivation ──────────────────────────────────

  describe('usingTmsOverage derivation', () => {
    it('sets usingTmsOverage=true when envelope rejected but TMS allowed (SSE)', () => {
      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 10, credits_used: 1, tokens_used: 100000,
        plan: 'pro', source: 'monthly',
        envelope_status: 'rejected',
        tms_status: 'allowed',
      })

      expect(useBillingStore.getState().usingTmsOverage).toBe(true)
    })

    it('sets usingTmsOverage=false when envelope allowed (SSE)', () => {
      useBillingStore.setState({ usingTmsOverage: true })

      useBillingStore.getState().updateFromSSE({
        type: 'billing', credits_remaining: 90, credits_used: 1, tokens_used: 5000,
        plan: 'pro', source: 'monthly',
        envelope_status: 'allowed',
        tms_status: 'allowed',
      })

      expect(useBillingStore.getState().usingTmsOverage).toBe(false)
    })

    it('sets usingTmsOverage=true via headers when rejected + allowed', () => {
      const headers = new Headers({
        'x-tm-ratelimit-status': 'rejected',
        'x-tm-ratelimit-tms-status': 'allowed',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().usingTmsOverage).toBe(true)
    })

    it('sets usingTmsOverage=false via headers when allowed', () => {
      useBillingStore.setState({ usingTmsOverage: true })

      const headers = new Headers({
        'x-tm-ratelimit-status': 'allowed_warning',
        'x-tm-ratelimit-tms-status': 'allowed',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().usingTmsOverage).toBe(false)
    })
  })

  // ── setEnvelopeFromMe ───────────────────────────────────────────

  describe('setEnvelopeFromMe', () => {
    it('sets all envelope fields from /v1/me response', () => {
      useBillingStore.getState().setEnvelopeFromMe({
        envelope: {
          monthlyLimit: 30_000_000,
          monthlyConsumed: 5_000_000,
          fiveHourUtilization: 0.25,
          fiveHourResetEpoch: 1712345678,
          sevenDayUtilization: 0.1,
          sevenDayResetEpoch: 1713000000,
        },
        tmsRemaining: 85,
      })

      const state = useBillingStore.getState()
      expect(state.envelopeMonthlyLimit).toBe(30_000_000)
      expect(state.envelopeMonthlyConsumed).toBe(5_000_000)
      expect(state.envelope5hUtilization).toBe(0.25)
      expect(state.envelope5hReset).toBe(1712345678)
      expect(state.envelope7dUtilization).toBe(0.1)
      expect(state.envelope7dReset).toBe(1713000000)
      expect(state.tmsRemaining).toBe(85)
    })

    it('does not set reset epoch if 0', () => {
      useBillingStore.setState({ envelope5hReset: 9999 })

      useBillingStore.getState().setEnvelopeFromMe({
        envelope: {
          monthlyLimit: 5_000_000,
          monthlyConsumed: 0,
          fiveHourUtilization: 0,
          fiveHourResetEpoch: 0, // no active window
          sevenDayUtilization: 0,
          sevenDayResetEpoch: 0,
        },
      })

      // Should keep existing reset epoch
      expect(useBillingStore.getState().envelope5hReset).toBe(9999)
    })

    it('handles missing envelope data gracefully', () => {
      useBillingStore.setState({ tmsRemaining: 10 })
      useBillingStore.getState().setEnvelopeFromMe({ tmsRemaining: 20 })
      expect(useBillingStore.getState().tmsRemaining).toBe(20)
    })
  })

  // ── getEffectiveUtilization ─────────────────────────────────────

  describe('getEffectiveUtilization', () => {
    it('returns utilization when window is active', () => {
      const futureEpoch = Math.floor(Date.now() / 1000) + 3600 // 1h from now
      expect(getEffectiveUtilization(0.75, futureEpoch)).toBe(0.75)
    })

    it('returns 0 when window has expired', () => {
      const pastEpoch = Math.floor(Date.now() / 1000) - 100 // 100s ago
      expect(getEffectiveUtilization(0.75, pastEpoch)).toBe(0)
    })

    it('returns 0 when resetEpoch is 0 (no active window)', () => {
      expect(getEffectiveUtilization(0.5, 0)).toBe(0)
    })

    it('returns 0 when resetEpoch is negative', () => {
      expect(getEffectiveUtilization(0.5, -1)).toBe(0)
    })

    it('returns 0 when resetEpoch equals current time (boundary)', () => {
      const nowSecs = Math.floor(Date.now() / 1000)
      expect(getEffectiveUtilization(0.5, nowSecs)).toBe(0) // >= means expired
    })
  })

  // ── Full request lifecycle ──────────────────────────────────────

  describe('full lifecycle: headers → SSE with envelope', () => {
    it('headers then SSE with rising utilization', () => {
      // 1. Headers arrive (pre-stream)
      const headers = new Headers({
        'X-Plan': 'pro',
        'X-Credits-Remaining': '95',
        'x-tm-ratelimit-status': 'allowed',
        'x-tm-ratelimit-5h-utilization': '0.30',
        'x-tm-ratelimit-5h-reset': '1712345678',
        'x-tm-ratelimit-7d-utilization': '0.10',
        'x-tm-ratelimit-7d-reset': '1713000000',
        'x-tm-ratelimit-tms-status': 'allowed',
        'x-tm-ratelimit-tms-remaining': '95',
      })
      useBillingStore.getState().updateFromHeaders(headers)

      expect(useBillingStore.getState().envelope5hUtilization).toBe(0.30)

      // 2. SSE arrives (post-stream, higher utilization)
      useBillingStore.getState().updateFromSSE({
        type: 'billing',
        credits_remaining: 93,
        credits_used: 2,
        tokens_used: 300000,
        plan: 'pro',
        source: 'monthly',
        envelope_5h_utilization: 0.45,
        envelope_5h_reset: 1712345678,
        envelope_7d_utilization: 0.13,
        envelope_7d_reset: 1713000000,
        envelope_status: 'allowed',
        tms_status: 'allowed',
        tms_remaining: 93,
        model_multiplier: 1,
        effective_tokens: 300000,
      })

      const state = useBillingStore.getState()
      expect(state.envelope5hUtilization).toBe(0.45) // increased
      expect(state.envelope7dUtilization).toBe(0.13)
      expect(state.creditsRemaining).toBe(93)
      expect(state.tmsRemaining).toBe(93)
      expect(state.lastEffectiveTokens).toBe(300000)
      expect(state.modelMultiplier).toBe(1)
      expect(state.usingTmsOverage).toBe(false)
    })
  })
})
