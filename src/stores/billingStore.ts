import { create } from 'zustand'

// ── Types (aligned with backend types.ts) ──

export type UserPlanName = 'explorer' | 'pro' | 'business-4x' | 'business-8x'
export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'
export type TmsOverageStatus = 'allowed' | 'rejected'

export interface BillingSSEEvent {
  type: 'billing'
  // Legacy
  credits_remaining: number
  credits_used: number
  tokens_used: number
  plan: string
  source: string
  // Token envelope
  envelope_5h_utilization?: number
  envelope_5h_reset?: number
  envelope_7d_utilization?: number
  envelope_7d_reset?: number
  envelope_status?: RateLimitStatus
  tms_status?: TmsOverageStatus
  tms_remaining?: number
  model_multiplier?: number
  effective_tokens?: number
}

// ── Store ──
//
// The backend is the source of truth for credit calculations.
// This store receives data from:
//   1. /v1/me endpoint on login (via fetchBillingInfo in firebaseAuth)
//   2. Response headers (X-Credits-Remaining, X-Plan, x-tm-ratelimit-*) — before streaming starts
//   3. SSE billing event — after streaming ends (exact, post-token-extras)

interface BillingState {
  // Core
  plan: UserPlanName
  isActive: boolean
  isLoaded: boolean

  // Credits / TMS (backend is source of truth)
  creditsRemaining: number | null
  planCapacity: number
  noCredits: boolean

  // SSE live tracking (updated during streaming)
  lastCreditsUsed: number
  lastTokensUsed: number
  lastSource: string

  // Token envelope (rate limit windows)
  envelope5hUtilization: number       // 0.0-1.0
  envelope5hReset: number             // epoch seconds
  envelope7dUtilization: number       // 0.0-1.0
  envelope7dReset: number             // epoch seconds
  envelopeStatus: RateLimitStatus
  representativeClaim: '5h' | '7d' | 'monthly'
  tmsStatus: TmsOverageStatus
  tmsRemaining: number
  usingTmsOverage: boolean
  modelMultiplier: number
  lastEffectiveTokens: number

  // Envelope monthly (from /v1/me)
  envelopeMonthlyLimit: number
  envelopeMonthlyConsumed: number
}

interface BillingActions {
  updateFromSSE: (data: BillingSSEEvent) => void
  updateFromHeaders: (headers: Headers) => void
  setEnvelopeFromMe: (data: {
    envelope?: {
      monthlyLimit: number; monthlyConsumed: number
      fiveHourUtilization: number; fiveHourResetEpoch: number
      sevenDayUtilization: number; sevenDayResetEpoch: number
    }
    tmsRemaining?: number
  }) => void
  setNoCredits: () => void
  clearNoCredits: () => void
  reset: () => void
}

const INITIAL_STATE: BillingState = {
  plan: 'explorer',
  isActive: true,
  isLoaded: false,
  creditsRemaining: null,
  planCapacity: 10,
  noCredits: false,
  lastCreditsUsed: 0,
  lastTokensUsed: 0,
  lastSource: '',
  // Envelope defaults
  envelope5hUtilization: 0,
  envelope5hReset: 0,
  envelope7dUtilization: 0,
  envelope7dReset: 0,
  envelopeStatus: 'allowed',
  representativeClaim: '5h',
  tmsStatus: 'allowed',
  tmsRemaining: 0,
  usingTmsOverage: false,
  modelMultiplier: 1,
  lastEffectiveTokens: 0,
  envelopeMonthlyLimit: 0,
  envelopeMonthlyConsumed: 0,
}

export const useBillingStore = create<BillingState & BillingActions>((set, get) => ({
  ...INITIAL_STATE,

  updateFromSSE: (data) => {
    const plan = (data.plan || get().plan) as UserPlanName
    const updates: Partial<BillingState> = {
      creditsRemaining: data.credits_remaining,
      plan,
      lastCreditsUsed: data.credits_used,
      lastTokensUsed: data.tokens_used,
      lastSource: data.source,
      noCredits: data.credits_remaining <= 0,
    }

    // Token envelope fields (graceful — old backends won't send these)
    if (data.envelope_5h_utilization !== undefined) updates.envelope5hUtilization = data.envelope_5h_utilization
    if (data.envelope_5h_reset && data.envelope_5h_reset > 0) updates.envelope5hReset = data.envelope_5h_reset
    if (data.envelope_7d_utilization !== undefined) updates.envelope7dUtilization = data.envelope_7d_utilization
    if (data.envelope_7d_reset && data.envelope_7d_reset > 0) updates.envelope7dReset = data.envelope_7d_reset
    if (data.envelope_status !== undefined) updates.envelopeStatus = data.envelope_status
    if (data.tms_status !== undefined) updates.tmsStatus = data.tms_status
    if (data.tms_remaining !== undefined) updates.tmsRemaining = data.tms_remaining
    if (data.model_multiplier !== undefined) updates.modelMultiplier = data.model_multiplier
    if (data.effective_tokens !== undefined) updates.lastEffectiveTokens = data.effective_tokens

    // Derive usingTmsOverage
    if (data.envelope_status === 'rejected' && data.tms_status === 'allowed') {
      updates.usingTmsOverage = true
    } else if (data.envelope_status !== undefined) {
      updates.usingTmsOverage = false
    }

    set(updates)
  },

  updateFromHeaders: (headers) => {
    const updates: Partial<BillingState> = {}

    // Legacy headers
    const remaining = headers.get('X-Credits-Remaining')
    const planHeader = headers.get('X-Plan')
    if (planHeader) updates.plan = planHeader as UserPlanName
    if (remaining !== null) {
      const parsed = parseInt(remaining, 10)
      if (!isNaN(parsed)) {
        updates.creditsRemaining = parsed
        updates.noCredits = parsed <= 0
      }
    }

    // Rate limit headers (x-tm-ratelimit-*)
    const rlStatus = headers.get('x-tm-ratelimit-status')
    if (rlStatus) updates.envelopeStatus = rlStatus as RateLimitStatus

    const h5util = headers.get('x-tm-ratelimit-5h-utilization')
    if (h5util) updates.envelope5hUtilization = parseFloat(h5util)

    const h5reset = headers.get('x-tm-ratelimit-5h-reset')
    if (h5reset) {
      const parsed = parseInt(h5reset, 10)
      if (parsed > 0) updates.envelope5hReset = parsed
    }

    const d7util = headers.get('x-tm-ratelimit-7d-utilization')
    if (d7util) updates.envelope7dUtilization = parseFloat(d7util)

    const d7reset = headers.get('x-tm-ratelimit-7d-reset')
    if (d7reset) {
      const parsed = parseInt(d7reset, 10)
      if (parsed > 0) updates.envelope7dReset = parsed
    }

    const claim = headers.get('x-tm-ratelimit-representative-claim')
    if (claim) updates.representativeClaim = claim as '5h' | '7d' | 'monthly'

    const tmsStatus = headers.get('x-tm-ratelimit-tms-status')
    if (tmsStatus) updates.tmsStatus = tmsStatus as TmsOverageStatus

    const tmsRem = headers.get('x-tm-ratelimit-tms-remaining')
    if (tmsRem) updates.tmsRemaining = parseInt(tmsRem, 10)

    // Derive usingTmsOverage from headers
    if (rlStatus === 'rejected' && tmsStatus === 'allowed') {
      updates.usingTmsOverage = true
    } else if (rlStatus) {
      updates.usingTmsOverage = false
    }

    if (Object.keys(updates).length > 0) set(updates)
  },

  setEnvelopeFromMe: (data) => {
    const updates: Partial<BillingState> = {}
    if (data.envelope) {
      updates.envelopeMonthlyLimit = data.envelope.monthlyLimit
      updates.envelopeMonthlyConsumed = data.envelope.monthlyConsumed
      updates.envelope5hUtilization = data.envelope.fiveHourUtilization
      updates.envelope7dUtilization = data.envelope.sevenDayUtilization
      if (data.envelope.fiveHourResetEpoch > 0) updates.envelope5hReset = data.envelope.fiveHourResetEpoch
      if (data.envelope.sevenDayResetEpoch > 0) updates.envelope7dReset = data.envelope.sevenDayResetEpoch
    }
    if (data.tmsRemaining !== undefined) updates.tmsRemaining = data.tmsRemaining
    if (Object.keys(updates).length > 0) set(updates)
  },

  setNoCredits: () => set({ noCredits: true, creditsRemaining: 0 }),

  clearNoCredits: () => set({ noCredits: false }),

  reset: () => set({ ...INITIAL_STATE }),
}))
