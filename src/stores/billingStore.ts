import { create } from 'zustand'

// ── Types (aligned with backend types.ts) ──

export type UserPlanName = 'explorer' | 'pro' | 'business-4x' | 'business-8x'

export interface BillingSSEEvent {
  type: 'billing'
  credits_remaining: number
  credits_used: number
  tokens_used: number
  plan: string
  source: string
}

// ── Store ──
//
// The backend is the source of truth for credit calculations.
// This store receives data from:
//   1. /v1/me endpoint on login (via fetchBillingInfo in firebaseAuth)
//   2. Response headers (X-Credits-Remaining, X-Plan) — before streaming starts
//   3. SSE billing event — after streaming ends (exact, post-token-extras)

interface BillingState {
  // Core
  plan: UserPlanName
  isActive: boolean
  isLoaded: boolean              // true after first fetch

  // Credits (backend is source of truth)
  creditsRemaining: number | null
  planCapacity: number           // for progress bar scaling (set once from initial remaining)
  noCredits: boolean

  // SSE live tracking (updated during streaming)
  lastCreditsUsed: number        // credits consumed in last message
  lastTokensUsed: number         // tokens consumed in last message
  lastSource: string             // 'daily' | 'monthly' | 'rollover' | 'purchased'
}

interface BillingActions {
  /** Update from SSE billing event during streaming */
  updateFromSSE: (data: BillingSSEEvent) => void
  /** Update from response headers (X-Credits-Remaining, X-Plan) */
  updateFromHeaders: (headers: Headers) => void
  setNoCredits: () => void
  clearNoCredits: () => void
  reset: () => void
}

export const useBillingStore = create<BillingState & BillingActions>((set, get) => ({
  plan: 'explorer',
  isActive: true,
  isLoaded: false,

  creditsRemaining: null,
  planCapacity: 10,
  noCredits: false,

  lastCreditsUsed: 0,
  lastTokensUsed: 0,
  lastSource: '',

  updateFromSSE: (data) => {
    const plan = (data.plan || get().plan) as UserPlanName
    set({
      creditsRemaining: data.credits_remaining,
      plan,
      // planCapacity stays as-is — set by /v1/me on login
      lastCreditsUsed: data.credits_used,
      lastTokensUsed: data.tokens_used,
      lastSource: data.source,
      noCredits: data.credits_remaining <= 0,
    })
  },

  updateFromHeaders: (headers) => {
    const remaining = headers.get('X-Credits-Remaining')
    const planHeader = headers.get('X-Plan')
    const updates: Partial<BillingState> = {}

    // Always update plan from header — independent of credits
    if (planHeader) {
      updates.plan = planHeader as UserPlanName
    }

    // Update credits if present
    if (remaining !== null) {
      const parsed = parseInt(remaining, 10)
      if (!isNaN(parsed)) {
        updates.creditsRemaining = parsed
        // planCapacity stays as-is — set by /v1/me on login
        updates.noCredits = parsed <= 0
      }
    }

    if (Object.keys(updates).length > 0) {
      set(updates)
    }
  },

  setNoCredits: () => set({ noCredits: true, creditsRemaining: 0 }),

  clearNoCredits: () => set({ noCredits: false }),

  reset: () => set({
    plan: 'explorer',
    isActive: true,
    isLoaded: false,
    creditsRemaining: null,
    planCapacity: 10,
    noCredits: false,
    lastCreditsUsed: 0,
    lastTokensUsed: 0,
    lastSource: '',
  }),
}))
