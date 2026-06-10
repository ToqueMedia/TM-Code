import { create } from 'zustand'
import type { Promotion } from './promotionsStore'

// ── Types (mirrored from backend types.ts) ──

// Four plans (caps in tokens/cycle — derived from `monthly_usd × (1 − 0.30) / 0.97`,
// where $0.97/M is the blended provider rate with an 80/20 input/output mix):
//   - 'explorer' (free): 1.5M
//   - 'vibe':            10.82M
//   - 'pro':             20.91M
//   - 'max':             129.81M
// Pricing is admin-controlled in toquemedia-studio; the IDE only consumes the
// plan name + token budget reported by the backend. The active AI provider/model
// is published separately as Active AI Config by the Control Plane.
export type UserPlanName = 'explorer' | 'vibe' | 'pro' | 'max' | 'welcome' | 'byok-only'

export type CostBudgetStatus =
  | 'allowed'
  | 'allowed_warning'
  | 'allowed_critical'
  | 'allowed_overage'
  | 'rejected'

/** Shape of the /v1/me response body */
export interface MeResponse {
  plan: UserPlanName
  isActive: boolean
  isAdmin?: boolean
  billing: {
    consumedPct: number
    tokensConsumed: number
    tokenBudget: number
    cycleEnd: string
    extraUsageBalance: number
    status: CostBudgetStatus
  }
  /** Global feature toggles. Missing → all flags default OFF. */
  features?: {
    byokEnabled?: boolean
  }
  /** Active promotions from Firestore (filtered by time window + surface=ide). */
  promotions?: Promotion[]
}

// ── Store ──
//
// The backend is the source of truth. The store receives data from:
//   1. /v1/me on app launch + window focus + post-purchase deep link
//      (event-driven, NEVER polling — see memory feedback_no_polling.md)
//   2. Response headers, when an administrative gateway returns budget metadata

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
  updateFromHeaders: (headers: Headers) => void
  updateFromMe: (data: MeResponse) => void
  addEstimatedUsage: (tokens: number) => void
  setNoCredits: () => void
  /** Clear noCredits flag without changing the underlying status — used by
   *  agentService before each request as an optimistic "maybe it's resolved" reset.
   *  The next Control Plane refresh or budget header will set the real state. */
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

/**
 * "Consumo extra" — extra balance expressed as a percentage of the current
 * plan's cycle budget. Single source of truth shared across CreditIndicator
 * (chat dropdown), SettingsView, and any other surface that exposes the metric.
 *
 * Example: tokenBudget = 2M, tmsRemaining = 500K → 25%.
 *
 * Returns null when there is nothing meaningful to render (no plan budget yet
 * or no extra balance) so callers can hide the row instead of showing 0%.
 */
export function extraConsumptionPct(tmsRemaining: number, tokenBudget: number): number | null {
  if (tokenBudget <= 0) return null
  if (tmsRemaining <= 0) return null
  return Math.round((tmsRemaining / tokenBudget) * 100)
}

export const useBillingStore = create<BillingState & BillingActions>((set) => ({
  ...INITIAL_STATE,

  /**
   * Apply budget headers if a gateway response includes them. The new AI
   * pass-through Worker does not add billing headers, so absence is normal.
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

    const tmsRaw = headers.get('X-Extra-Tokens')
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
      tmsRemaining: data.billing.extraUsageBalance,
      noCredits: data.billing.status === 'rejected',
    })
  },

  /**
   * Local optimistic usage used while the AI data-plane Worker streams
   * provider output. The pass-through Worker intentionally no longer emits
   * billing headers, so this keeps the header pill moving until /v1/me or
   * an administrative gateway response provides the authoritative numbers.
   */
  addEstimatedUsage: (tokens) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    const rounded = Math.ceil(tokens)
    set(state => {
      const tokensConsumed = state.tokensConsumed + rounded
      const consumedPct = state.tokenBudget > 0
        ? tokensConsumed / state.tokenBudget
        : state.consumedPct
      const status =
        state.status === 'rejected' || state.status === 'allowed_overage'
          ? state.status
          : consumedPct >= 1
            ? 'allowed_critical'
            : consumedPct >= 0.95
              ? 'allowed_critical'
              : consumedPct >= 0.8
                ? 'allowed_warning'
                : state.status
      return {
        tokensConsumed,
        consumedPct,
        status,
        lastTokensUsed: state.lastTokensUsed + rounded,
        lastUsedOverage: state.lastUsedOverage || consumedPct > 1 || state.status === 'allowed_overage',
      }
    })
  },

  setNoCredits: () => set({ noCredits: true, status: 'rejected' }),

  clearNoCredits: () => set({ noCredits: false }),

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
