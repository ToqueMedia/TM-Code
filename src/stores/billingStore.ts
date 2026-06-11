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
// O servidor é o ÚNICO ponto de verdade da contabilidade (2026-06): o worker
// ai-pass-through observa o `usage` de cada resposta, aplica o multiplicador
// do TM Speed e comita increments atómicos ao Firestore — a IDE não estima,
// não corrige e não persiste consumo (o antigo `persistTokensConsumed` +
// `addEstimatedUsage` foram removidos; eram a fonte das inconsistências:
// chat-mode sem billing, correção por turno errada, write absoluto
// last-writer-wins a esmagar o cycle-reset do servidor).
//
// O store recebe dados de:
//   1. /v1/me no arranque + window focus + deep link pós-compra
//      (event-driven, NUNCA polling — ver memória feedback_no_polling.md)
//   2. Headers X-Budget-*/X-Plan em CADA resposta do worker de IA
//      (estado pré-voo do turno — lag de ~1 turno em relação ao commit).

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

  // Overage credits (canonical: tokenBudget.extraUsageBalance on the backend)
  tmsRemaining: number

  // Last request stats (display-only — fed by the authoritative per-turn
  // usage, never used for accounting). ApiKeysSection uses it for the BYOK
  // cost estimate.
  lastTokensUsed: number

  // Emergency stop
  noCredits: boolean
}

interface BillingActions {
  updateFromHeaders: (headers: Headers) => void
  updateFromMe: (data: MeResponse) => void
  /** Display-only: accumulate the authoritative per-turn token total for the
   *  "last request" stat. No consumption math happens client-side. */
  addLastRequestTokens: (tokens: number) => void
  /** Zero the per-request stat at the start of a new agent run. */
  resetLastRequestStats: () => void
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
   * Apply the budget headers the AI pass-through worker emits on every
   * response (X-Plan / X-Budget-* — pre-flight state read from Firestore,
   * so they lag the in-flight turn's commit by one turn). Absence is still
   * tolerated: BYOK traffic bypasses the worker, and BUDGET_ENFORCEMENT=off
   * disables the billing path entirely.
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

  addLastRequestTokens: (tokens) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    set(state => ({ lastTokensUsed: state.lastTokensUsed + Math.ceil(tokens) }))
  },

  resetLastRequestStats: () => set({ lastTokensUsed: 0 }),

  setNoCredits: () => set({ noCredits: true, status: 'rejected' }),

  clearNoCredits: () => set({ noCredits: false }),

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
