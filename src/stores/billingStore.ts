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

/**
 * Returns effective utilization — 0 if the window has expired (resetEpoch in the past).
 * Prevents the display from showing stale high utilization after a window resets
 * without a new API call.
 */
export function getEffectiveUtilization(utilization: number, resetEpoch: number): number {
  if (resetEpoch <= 0) return 0 // no active window
  const nowSecs = Math.floor(Date.now() / 1000)
  if (nowSecs >= resetEpoch) return 0 // window expired
  return utilization
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
    const current = get()
    const plan = (data.plan || current.plan) as UserPlanName
    // credits_remaining is the legacy field that maps to TMS remaining.
    // Same monotonic + purchase-detection rule as tmsRemaining.
    let newCreditsRemaining = data.credits_remaining
    if (current.creditsRemaining !== null && current.creditsRemaining > 0) {
      const increase = data.credits_remaining - current.creditsRemaining
      const isPurchase = increase > Math.max(current.creditsRemaining * 0.1, 3)
      newCreditsRemaining = isPurchase ? data.credits_remaining : Math.min(data.credits_remaining, current.creditsRemaining)
    }
    const updates: Partial<BillingState> = {
      creditsRemaining: newCreditsRemaining,
      plan,
      lastCreditsUsed: data.credits_used,
      lastTokensUsed: data.tokens_used,
      lastSource: data.source,
      noCredits: newCreditsRemaining <= 0,
    }

    // Token envelope fields (graceful — old backends won't send these).
    // Utilization is monotonically increasing within a window — never accept a LOWER
    // value than the current one (prevents stale reads from resetting the display).
    // Exception: when reset epoch changes, a new window has started → accept the new value.
    // Utilization rules:
    // 1. Same window (epoch unchanged): monotonic increasing (Math.max)
    // 2. New window (epoch changed) with utilization > 0: accept (real consumption in new window)
    // 3. New window with utilization = 0: only accept if current utilization is also 0 or
    //    current window already expired. This prevents the "flash to 0%" that happens when
    //    headers arrive with util=0 before the SSE billing event reports actual consumption.
    if (data.envelope_5h_utilization !== undefined) {
      const newWindow = data.envelope_5h_reset !== undefined && data.envelope_5h_reset !== current.envelope5hReset
      if (!newWindow) {
        updates.envelope5hUtilization = Math.max(data.envelope_5h_utilization, current.envelope5hUtilization)
      } else if (data.envelope_5h_utilization > 0 || current.envelope5hUtilization === 0) {
        updates.envelope5hUtilization = data.envelope_5h_utilization
      }
      // else: new window with util=0 but current > 0 → skip (wait for SSE with real value)
      // DEBUG: trace resets
      if ((updates.envelope5hUtilization ?? current.envelope5hUtilization) < current.envelope5hUtilization) {
        console.warn(`[billing-debug] SSE 5h DECREASED: ${current.envelope5hUtilization} → ${updates.envelope5hUtilization}, newWindow=${newWindow}, incoming=${data.envelope_5h_utilization}, reset=${data.envelope_5h_reset}, currentReset=${current.envelope5hReset}`)
      }
    }
    if (data.envelope_5h_reset && data.envelope_5h_reset > 0) updates.envelope5hReset = data.envelope_5h_reset
    if (data.envelope_7d_utilization !== undefined) {
      const newWindow = data.envelope_7d_reset !== undefined && data.envelope_7d_reset !== current.envelope7dReset
      if (!newWindow) {
        updates.envelope7dUtilization = Math.max(data.envelope_7d_utilization, current.envelope7dUtilization)
      } else if (data.envelope_7d_utilization > 0 || current.envelope7dUtilization === 0) {
        updates.envelope7dUtilization = data.envelope_7d_utilization
      }
    }
    if (data.envelope_7d_reset && data.envelope_7d_reset > 0) updates.envelope7dReset = data.envelope_7d_reset
    if (data.envelope_status !== undefined) updates.envelopeStatus = data.envelope_status
    if (data.tms_status !== undefined) updates.tmsStatus = data.tms_status
    // TMS decreases during usage — reject stale higher values (Firestore eventual consistency).
    // But ACCEPT significant increases (>10% jump) which indicate a TMS purchase.
    if (data.tms_remaining !== undefined) {
      if (current.tmsRemaining <= 0) {
        updates.tmsRemaining = data.tms_remaining
      } else {
        const increase = data.tms_remaining - current.tmsRemaining
        const isPurchase = increase > Math.max(current.tmsRemaining * 0.1, 3)
        updates.tmsRemaining = isPurchase
          ? data.tms_remaining          // purchase — accept the higher value
          : Math.min(data.tms_remaining, current.tmsRemaining)  // normal usage — only decrease
      }
    }
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

    // Legacy headers — same monotonic rule as SSE
    const current = get()
    const remaining = headers.get('X-Credits-Remaining')
    const planHeader = headers.get('X-Plan')
    if (planHeader) updates.plan = planHeader as UserPlanName
    if (remaining !== null) {
      const parsed = parseInt(remaining, 10)
      if (!isNaN(parsed)) {
        if (current.creditsRemaining !== null && current.creditsRemaining > 0) {
          const increase = parsed - current.creditsRemaining
          const isPurchase = increase > Math.max(current.creditsRemaining * 0.1, 3)
          updates.creditsRemaining = isPurchase ? parsed : Math.min(parsed, current.creditsRemaining)
        } else {
          updates.creditsRemaining = parsed
        }
        updates.noCredits = (updates.creditsRemaining ?? parsed) <= 0
      }
    }

    // Rate limit headers (x-tm-ratelimit-*)
    // Monotonic rule: never accept lower utilization within the same window.
    const rlStatus = headers.get('x-tm-ratelimit-status')
    if (rlStatus) updates.envelopeStatus = rlStatus as RateLimitStatus

    const h5resetRaw = headers.get('x-tm-ratelimit-5h-reset')
    const h5resetParsed = h5resetRaw ? parseInt(h5resetRaw, 10) : 0
    if (h5resetParsed > 0) updates.envelope5hReset = h5resetParsed

    const h5util = headers.get('x-tm-ratelimit-5h-utilization')
    if (h5util) {
      const val = parseFloat(h5util)
      const newWindow = h5resetParsed > 0 && h5resetParsed !== current.envelope5hReset
      if (!newWindow) {
        updates.envelope5hUtilization = Math.max(val, current.envelope5hUtilization)
      } else if (val > 0 || current.envelope5hUtilization === 0) {
        updates.envelope5hUtilization = val
      }
      // DEBUG: trace resets
      if ((updates.envelope5hUtilization ?? current.envelope5hUtilization) < current.envelope5hUtilization) {
        console.warn(`[billing-debug] HEADERS 5h DECREASED: ${current.envelope5hUtilization} → ${updates.envelope5hUtilization}, newWindow=${newWindow}, val=${val}, h5reset=${h5resetParsed}, currentReset=${current.envelope5hReset}`)
      }
    }

    const d7resetRaw = headers.get('x-tm-ratelimit-7d-reset')
    const d7resetParsed = d7resetRaw ? parseInt(d7resetRaw, 10) : 0
    if (d7resetParsed > 0) updates.envelope7dReset = d7resetParsed

    const d7util = headers.get('x-tm-ratelimit-7d-utilization')
    if (d7util) {
      const val = parseFloat(d7util)
      const newWindow = d7resetParsed > 0 && d7resetParsed !== current.envelope7dReset
      if (!newWindow) {
        updates.envelope7dUtilization = Math.max(val, current.envelope7dUtilization)
      } else if (val > 0 || current.envelope7dUtilization === 0) {
        updates.envelope7dUtilization = val
      }
    }

    const claim = headers.get('x-tm-ratelimit-representative-claim')
    if (claim) updates.representativeClaim = claim as '5h' | '7d' | 'monthly'

    const tmsStatus = headers.get('x-tm-ratelimit-tms-status')
    if (tmsStatus) updates.tmsStatus = tmsStatus as TmsOverageStatus

    const tmsRem = headers.get('x-tm-ratelimit-tms-remaining')
    if (tmsRem) {
      const val = parseInt(tmsRem, 10)
      if (current.tmsRemaining <= 0) {
        updates.tmsRemaining = val
      } else {
        const increase = val - current.tmsRemaining
        const isPurchase = increase > Math.max(current.tmsRemaining * 0.1, 3)
        updates.tmsRemaining = isPurchase ? val : Math.min(val, current.tmsRemaining)
      }
    }

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

  reset: () => {
    console.warn('[billing-debug] FULL RESET called', new Error().stack?.split('\n').slice(1, 4).join(' ← '))
    set({ ...INITIAL_STATE })
  },
}))
