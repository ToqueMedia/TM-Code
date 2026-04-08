import { create } from 'zustand'

// ── Types (mirrored from backend types.ts) ──

export type UserPlanName = 'explorer' | 'pro' | 'business-4x' | 'business-8x'

export type CostBudgetStatus =
  | 'allowed'
  | 'allowed_warning'
  | 'allowed_critical'
  | 'allowed_overage'
  | 'rejected'

/** Shape of the SSE event injected by the worker at the end of /v1/chat/completions */
export interface BillingSSEEvent {
  type: 'billing'
  consumed_pct: number       // 0–1 normal cycle, > 1 in overage
  status: CostBudgetStatus
  tokens_used: number        // raw tokens consumed in THIS request
  tokens_consumed: number    // cumulative cycle total (post-commit prediction)
  cycle_end: string          // "YYYY-MM-DD"
  tms_remaining: number      // overage credits after this request
  plan: UserPlanName
  used_overage: boolean      // request charged to TMS overage (vs cycle)
}

/** Shape of the /v1/me response body */
export interface MeResponse {
  plan: UserPlanName
  isActive: boolean
  billing: {
    consumedPct: number
    tokensConsumed: number
    tokenBudget: number
    cycleEnd: string
    tmsPurchased: number
    status: CostBudgetStatus
  }
}

// ── Store ──
//
// The backend is the source of truth. The store receives data from:
//   1. /v1/me on app launch + window focus + post-purchase deep link
//      (event-driven, NEVER polling — see memory feedback_no_polling.md)
//   2. SSE billing event injected at the end of every /v1/chat/completions
//   3. Response headers (X-Budget-Pct, X-Budget-Status, X-Cycle-End, X-Tms-Remaining)

interface BillingState {
  // Identity
  plan: UserPlanName
  isActive: boolean
  isLoaded: boolean

  // Cost budget
  consumedPct: number        // 0–1 normal, > 1 overage
  tokensConsumed: number     // raw tokens in current cycle
  tokenBudget: number        // plan budget (depends on plan)
  cycleEnd: string           // "YYYY-MM-DD"
  status: CostBudgetStatus

  // Overage credits (canonical: tmsQuota.purchasedBalance on the backend)
  tmsRemaining: number

  // Last request stats (for UI feedback)
  lastTokensUsed: number
  lastUsedOverage: boolean

  // Emergency stop
  noCredits: boolean
}

interface BillingActions {
  updateFromSSE: (data: BillingSSEEvent) => void
  updateFromHeaders: (headers: Headers) => void
  updateFromMe: (data: MeResponse) => void
  setNoCredits: () => void
  /** Clear noCredits flag without changing the underlying status — used by
   *  agentService before each request as an optimistic "maybe it's resolved" reset.
   *  The next response (headers + SSE) will set the real state. */
  clearNoCredits: () => void
  reset: () => void
}

const INITIAL_STATE: BillingState = {
  plan: 'explorer',
  isActive: true,
  isLoaded: false,
  consumedPct: 0,
  tokensConsumed: 0,
  tokenBudget: 0,
  cycleEnd: '',
  status: 'allowed',
  tmsRemaining: 0,
  lastTokensUsed: 0,
  lastUsedOverage: false,
  noCredits: false,
}

/** Check if a status reflects "no more service available". */
export function isBlocked(status: CostBudgetStatus): boolean {
  return status === 'rejected'
}

/** Check if the user is in overage mode (cycle exhausted, paying via credits). */
export function isInOverage(status: CostBudgetStatus): boolean {
  return status === 'allowed_overage'
}

/**
 * Should the UI render overage indicators? True when EITHER the request was
 * charged to TMS overage (status='allowed_overage') OR the cycle counter has
 * exceeded 100% from a spillover request (consumedPct > 1). Both cases mean
 * the cycle bar should show the > 100% segment.
 */
export function isInOverageState(status: CostBudgetStatus, consumedPct: number): boolean {
  return status === 'allowed_overage' || consumedPct > 1
}

export const useBillingStore = create<BillingState & BillingActions>((set) => ({
  ...INITIAL_STATE,

  /**
   * Apply an SSE billing event from /v1/chat/completions. The backend sends
   * monotonically-correct values (computed with atomic Firestore ops), so the
   * IDE just trusts and applies. Includes tokens_consumed (cumulative total)
   * directly — no derivation from consumedPct × tokenBudget.
   */
  updateFromSSE: (data) => {
    set({
      consumedPct: data.consumed_pct,
      tokensConsumed: data.tokens_consumed,
      status: data.status,
      cycleEnd: data.cycle_end,
      tmsRemaining: data.tms_remaining,
      plan: data.plan,
      lastTokensUsed: data.tokens_used,
      lastUsedOverage: data.used_overage,
      noCredits: data.status === 'rejected',
    })
  },

  /**
   * Apply rate-limit headers from a /v1/chat/completions response. These arrive
   * BEFORE the SSE billing event, so they reflect the pre-stream state. The
   * SSE event arrives later with the post-commit state and supersedes.
   *
   * Updates BOTH consumedPct AND tokensConsumed (from X-Tokens-Consumed) so
   * the dropdown's absolute count stays consistent with the % indicator.
   */
  updateFromHeaders: (headers) => {
    const updates: Partial<BillingState> = {}

    const pctRaw = headers.get('X-Budget-Pct')
    if (pctRaw) {
      const pct = parseFloat(pctRaw)
      if (!isNaN(pct)) updates.consumedPct = pct
    }

    const tokensRaw = headers.get('X-Tokens-Consumed')
    if (tokensRaw) {
      const tokens = parseInt(tokensRaw, 10)
      if (!isNaN(tokens)) updates.tokensConsumed = tokens
    }

    const statusRaw = headers.get('X-Budget-Status')
    if (statusRaw) {
      updates.status = statusRaw as CostBudgetStatus
      updates.noCredits = statusRaw === 'rejected'
    }

    const cycleEnd = headers.get('X-Cycle-End')
    if (cycleEnd) updates.cycleEnd = cycleEnd

    const tmsRaw = headers.get('X-Tms-Remaining')
    if (tmsRaw) {
      const tms = parseInt(tmsRaw, 10)
      if (!isNaN(tms)) updates.tmsRemaining = tms
    }

    const planHeader = headers.get('X-Plan')
    if (planHeader) updates.plan = planHeader as UserPlanName

    if (Object.keys(updates).length > 0) set(updates)
  },

  /**
   * Bootstrap from /v1/me. Called on app launch, window focus, and post-purchase
   * deep link callbacks. Backend authoritative — overwrites local state.
   */
  updateFromMe: (data) => {
    set({
      plan: data.plan,
      isActive: data.isActive,
      isLoaded: true,
      consumedPct: data.billing.consumedPct,
      tokensConsumed: data.billing.tokensConsumed,
      tokenBudget: data.billing.tokenBudget,
      cycleEnd: data.billing.cycleEnd,
      status: data.billing.status,
      tmsRemaining: data.billing.tmsPurchased,
      noCredits: data.billing.status === 'rejected',
    })
  },

  setNoCredits: () => set({ noCredits: true, status: 'rejected' }),

  clearNoCredits: () => set({ noCredits: false }),

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
