import { useBillingStore } from '../billingStore'

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
})
