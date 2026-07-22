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

/**
 * Contexto de EQUIPA (Plano de Equipas). Presente só quando o user é membro de
 * uma equipa. O `billing` principal já traz a FATIA do membro projetada (o
 * control-plane mete `mySliceTokens`/`myConsumedPct` lá); este bloco dá o
 * enquadramento "a tua fatia / o bolo" + o papel (para o CTA de bloqueio).
 */
export interface TeamBillingContext {
  teamId: string
  tier: string          // 'team-pro' | 'team-max'
  pieTotal: number      // tokens do bolo (tier base + comprado)
  mySliceTokens: number // teto do membro em tokens
  mySlicePct: number    // 0..1 — fatia do membro na pie
  role: string          // 'owner' | 'member'
}

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
    /** Data de expiração da SUBSCRIÇÃO (ISO; ≠ cycleEnd, que é o reset mensal
     *  de tokens). '' para explorer/desconhecida. Alimenta o aviso "o plano
     *  expira em N dias". Ausente em workers antigos (pré-2026-07-14). */
    planExpiresAt?: string
  }
  /** Bloco de equipa (control-plane TeamBillingSummary). Ausente = consumo NÃO
   *  está em modo equipa agora (modo pessoal ou sem equipa). */
  team?: {
    teamId: string
    tier: string
    pieTotal: number
    mySlicePct: number
    mySliceTokens: number
    role: string
  }
  /** Pertença ESTÁVEL — presente mesmo em modo pessoal; a IDE usa-a para oferecer
   *  o toggle pessoal/equipa. `teamActive` = consumo a faturar a equipa agora. */
  teamMemberOf?: string
  teamActive?: boolean
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
// prompt sem billing, correção por turno errada, write absoluto
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
  /** Expiração da SUBSCRIÇÃO (ISO) — '' quando não aplicável. Ver MeResponse. */
  planExpiresAt: string
  status: CostBudgetStatus

  // Overage credits (canonical: tokenBudget.extraUsageBalance on the backend)
  tmsRemaining: number

  // Last request stats (display-only — fed by the authoritative per-turn
  // usage, never used for accounting). ApiKeysSection uses it for the BYOK
  // cost estimate.
  lastTokensUsed: number

  // Emergency stop
  noCredits: boolean

  // Plano de Equipas: contexto da equipa quando o consumo está em MODO EQUIPA
  // (null em modo pessoal). Enquadra "a tua fatia / o bolo" + CTA de bloqueio.
  team: TeamBillingContext | null
  // Pertença estável (id da equipa) — presente mesmo em modo pessoal, para a IDE
  // mostrar e permitir o toggle pessoal/equipa. null = não pertence a equipa.
  teamMemberOf: string | null
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

const DEFAULT_STATE: BillingState = {
  plan: 'explorer',
  isActive: true,
  isLoaded: false,
  consumedPct: 0,
  tokensConsumed: 0,
  tokenBudget: 0,
  cycleEnd: '',
  planExpiresAt: '',
  status: 'allowed',
  tmsRemaining: 0,
  lastTokensUsed: 0,
  noCredits: false,
  team: null,
  teamMemberOf: null,
}

// ── Cache local do snapshot de billing (arranque sem flash de plano) ──
//
// Sem isto, a IDE abria com os defaults (explorer) e o plano real só
// aparecia depois de Firebase restore → App Check → /v1/me — segundos de
// UI errada em cada arranque (pedido do user 2026-06-11). A cache guarda o
// ÚLTIMO snapshot autoritativo por utilizador; o boot hidrata a store de
// forma síncrona antes do primeiro render, e o /v1/me seguinte corrige e
// re-grava. É display-only — nenhuma decisão de cobrança vive no cliente
// ([[billing-single-source-of-truth]]); o enforcement real é o worker.
//
// Invalidação: troca de conta (uid difere → firebaseAuth faz reset),
// logout (reset limpa), e idade > 7 dias (o ciclo provavelmente rolou —
// melhor defaults do que números antigos).

const BILLING_CACHE_KEY = 'tm-billing-cache-v1'
const BILLING_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface BillingCacheRecord {
  v: 1
  uid: string
  savedAt: number
  plan: UserPlanName
  isActive: boolean
  consumedPct: number
  tokensConsumed: number
  tokenBudget: number
  cycleEnd: string
  planExpiresAt?: string
  status: CostBudgetStatus
  tmsRemaining: number
  team?: TeamBillingContext | null
  teamMemberOf?: string | null
}

function loadBillingCache(): BillingCacheRecord | null {
  try {
    const raw = localStorage.getItem(BILLING_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BillingCacheRecord
    if (parsed?.v !== 1 || typeof parsed.uid !== 'string') return null
    if (Date.now() - (parsed.savedAt ?? 0) > BILLING_CACHE_MAX_AGE_MS) return null
    return parsed
  } catch {
    return null
  }
}

/** uid do snapshot em cache — firebaseAuth compara com o uid restaurado e
 *  faz reset quando a conta mudou (não mostrar o plano de outro user). */
export function getCachedBillingUid(): string | null {
  return loadBillingCache()?.uid ?? null
}

/** Grava o estado atual como snapshot de arranque. Chamado pelo
 *  firebaseAuth logo após cada updateFromMe (que tem o uid). */
export function persistBillingCache(uid: string): void {
  try {
    const s = useBillingStore.getState()
    const record: BillingCacheRecord = {
      v: 1,
      uid,
      savedAt: Date.now(),
      plan: s.plan,
      isActive: s.isActive,
      consumedPct: s.consumedPct,
      tokensConsumed: s.tokensConsumed,
      tokenBudget: s.tokenBudget,
      cycleEnd: s.cycleEnd,
      planExpiresAt: s.planExpiresAt,
      status: s.status,
      tmsRemaining: s.tmsRemaining,
      team: s.team,
      teamMemberOf: s.teamMemberOf,
    }
    localStorage.setItem(BILLING_CACHE_KEY, JSON.stringify(record))
  } catch {
    /* quota/indisponível — a cache é só otimização de arranque */
  }
}

function clearBillingCache(): void {
  try { localStorage.removeItem(BILLING_CACHE_KEY) } catch { /* noop */ }
}

/** Estado inicial: defaults + snapshot em cache quando existe. `isLoaded`
 *  continua false — semanticamente significa "o /v1/me desta sessão ainda
 *  não respondeu"; os valores hidratados são otimistas (stale-then-refresh). */
function buildInitialState(): BillingState {
  const cached = loadBillingCache()
  if (!cached) return DEFAULT_STATE
  return {
    ...DEFAULT_STATE,
    plan: cached.plan,
    isActive: cached.isActive,
    consumedPct: cached.consumedPct,
    tokensConsumed: cached.tokensConsumed,
    tokenBudget: cached.tokenBudget,
    cycleEnd: cached.cycleEnd,
    planExpiresAt: cached.planExpiresAt ?? '',
    status: cached.status,
    tmsRemaining: cached.tmsRemaining,
    noCredits: cached.status === 'rejected',
    team: cached.team ?? null,
    teamMemberOf: cached.teamMemberOf ?? null,
  }
}

const INITIAL_STATE: BillingState = buildInitialState()

/** Check if a status reflects "no more service available". */
export function isBlocked(status: CostBudgetStatus): boolean {
  return status === 'rejected'
}

/**
 * Team-collaboration gate — the SINGLE source of truth for whether the team
 * indicator, Team Chat, and Live Preview sharing should be shown/active.
 *
 * True when the user belongs to a team AND the team plan's term hasn't lapsed.
 * The check is DATE-BASED on purpose: it must short-circuit the 7-day boot cache
 * (which persists `teamMemberOf` + `planExpiresAt` and can otherwise resurrect a
 * lapsed membership before /v1/me refreshes). Once `planExpiresAt` is in the
 * past, collaboration hides immediately, even offline. An empty `planExpiresAt`
 * (old worker / unknown) stays permissive — there was never an expiry to enforce.
 *
 * NOTE: `teamActive` is deliberately NOT used here — it is the personal/team
 * BILLING toggle, not plan validity. A member in personal-billing mode is still
 * a member and must keep collaboration.
 */
export function isTeamCollabActive(
  s: Pick<BillingState, 'teamMemberOf' | 'planExpiresAt'>,
): boolean {
  if (!s.teamMemberOf) return false
  if (s.planExpiresAt) {
    const exp = Date.parse(s.planExpiresAt)
    if (!Number.isNaN(exp) && exp <= Date.now()) return false
  }
  return true
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

    // Contexto de equipa (§3.5) — só ATUALIZA quando o header está presente
    // (pedido de equipa); nunca LIMPA (isso é autoridade do /v1/me). Mantém o
    // enquadramento fatia/bolo vivo entre chamadas ao /v1/me.
    const teamId = headers.get('X-Team-Id')
    if (teamId) {
      const sliceTokens = parseInt(headers.get('X-Slice-Tokens') || '', 10)
      const pieTotal = parseInt(headers.get('X-Pie-Total') || '', 10)
      const tier = headers.get('X-Team-Tier') || ''
      set(state => ({
        ...updates,
        team: {
          teamId,
          tier: tier || state.team?.tier || '',
          pieTotal: Number.isFinite(pieTotal) ? pieTotal : (state.team?.pieTotal ?? 0),
          mySliceTokens: Number.isFinite(sliceTokens) ? sliceTokens : (state.team?.mySliceTokens ?? 0),
          mySlicePct: Number.isFinite(pieTotal) && pieTotal > 0 && Number.isFinite(sliceTokens)
            ? sliceTokens / pieTotal
            : (state.team?.mySlicePct ?? 0),
          role: state.team?.role ?? 'member',
        },
      }))
      return
    }

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
      planExpiresAt: data.billing.planExpiresAt ?? '',
      status: data.billing.status,
      tmsRemaining: data.billing.extraUsageBalance,
      noCredits: data.billing.status === 'rejected',
      // /v1/me é autoritativo: define OU LIMPA o contexto de equipa.
      team: data.team
        ? {
            teamId: data.team.teamId,
            tier: data.team.tier,
            pieTotal: data.team.pieTotal,
            mySliceTokens: data.team.mySliceTokens,
            mySlicePct: data.team.mySlicePct,
            role: data.team.role,
          }
        : null,
      teamMemberOf: data.teamMemberOf ?? null,
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
    // Logout/troca de conta: volta aos VERDADEIROS defaults (não ao
    // snapshot hidratado) e apaga a cache de arranque.
    clearBillingCache()
    set({ ...DEFAULT_STATE })
  },
}))
