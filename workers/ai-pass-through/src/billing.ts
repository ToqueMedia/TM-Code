/**
 * Contabilidade de consumo — autoritativa, no data-plane.
 *
 * Antes disto, TODO o billing era trust-the-client: a IDE estimava tokens
 * (chars/4), escrevia valores ABSOLUTOS em `users/{uid}.tokenBudget` via
 * Firestore client-side (last-writer-wins entre dispositivos, clobber do
 * cycle-reset do servidor), e o chat-mode nem sequer reportava. O
 * `commitTokenConsumption()` do control-plane existia mas nunca era chamado.
 *
 * Este módulo fecha o ciclo no único sítio que vê TODOS os pedidos de IA:
 *
 *   1. Pré-voo (`getUserBudgetState`) — UMA leitura cacheada (60s) de
 *      `users/{uid}` com `userPlan` + `tokenBudget.*`. Serve o gate de
 *      orçamento E a elegibilidade do TM Speed (substitui a leitura própria
 *      do planGate — zero round-trips extra).
 *   2. `checkCostBudget` — porte 1:1 dos thresholds do control-plane
 *      (80/95/100%, overage via extraUsageBalance, rejected).
 *   3. `commitTokenConsumption` — porte 1:1 do control-plane: increment
 *      atómico de `tokenBudget.tokensConsumed` (+ decremento do
 *      `tokenBudget.extraUsageBalance` com floor a 0 em overage), via
 *      `ctx.waitUntil` depois do stream terminar. O multiplicador do TM
 *      Speed aplica-se AQUI (server-side) — a IDE deixa de ser quem decide
 *      quanto se cobra.
 *
 * Custo: ~1 leitura Firestore/60s/utilizador + 1 write/pedido (waitUntil,
 * não bloqueia a resposta). Sem polling, sem cron, sem Durable Objects.
 *
 * Enforcement é progressivo via `BUDGET_ENFORCEMENT`:
 *   - 'off'     — sem gate, sem commit (kill-switch).
 *   - 'shadow'  — contabiliza + emite headers, NUNCA bloqueia (default; rollout seguro).
 *   - 'enforce' — `rejected` → 402 tm_budget_exhausted.
 */

import type { Env, Fetcher } from './types'
import { resolveFirestoreAuthHeaders } from './googleAuth'

// ── Plan budgets ──────────────────────────────────────────────────────────
//
// Espelho de toquemedia-studio-api/src/types.ts (PLAN_TOKEN_BUDGETS). O
// control-plane lê do Firestore `subscription_plans`; o data-plane usa este
// mapa + override por env (`PLAN_BUDGETS_JSON`) para não pagar uma leitura
// extra por pedido. Mudanças de pricing exigem atualizar o env/deploy — o
// drift é aceitável porque o /v1/me continua a ser a fonte do UI.

const DEFAULT_PLAN_BUDGETS: Record<string, number> = {
  explorer: 1_500_000,
  vibe: 10_820_000,
  pro: 20_910_000,
  max: 129_810_000,
  welcome: 32_500_000,
  'byok-only': 0,
}

export function resolvePlanBudgets(env: Env): Record<string, number> {
  const raw = typeof env.PLAN_BUDGETS_JSON === 'string' ? env.PLAN_BUDGETS_JSON.trim() : ''
  if (!raw) return DEFAULT_PLAN_BUDGETS
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const merged: Record<string, number> = { ...DEFAULT_PLAN_BUDGETS }
    for (const [plan, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) merged[plan] = value
    }
    return merged
  } catch {
    return DEFAULT_PLAN_BUDGETS
  }
}

export type BudgetEnforcementMode = 'off' | 'shadow' | 'enforce'

export function resolveEnforcementMode(env: Env): BudgetEnforcementMode {
  const raw = typeof env.BUDGET_ENFORCEMENT === 'string' ? env.BUDGET_ENFORCEMENT.toLowerCase() : ''
  if (raw === 'off' || raw === 'enforce') return raw
  return 'shadow'
}

export function resolveSpeedMultiplier(env: Env): number {
  const raw = typeof env.TM_SPEED_BILLING_MULTIPLIER === 'string' ? Number(env.TM_SPEED_BILLING_MULTIPLIER) : NaN
  return Number.isFinite(raw) && raw >= 1 ? raw : 3
}

// ── User budget state (cached read) ──────────────────────────────────────

export interface UserBudgetState {
  plan: string
  tokensConsumed: number
  extraUsageBalance: number
  cycleEnd: string
}

const STATE_CACHE_MS = 60_000
let stateCache = new Map<string, { state: UserBudgetState | null; expiresAt: number }>()

export function clearBudgetStateCache(): void {
  stateCache = new Map()
}

const DEFAULT_FIRESTORE_BASE = 'https://firestore.googleapis.com'

function firestoreBase(env: Env): string {
  return typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE
    ? env.FIRESTORE_REST_BASE.replace(/\/+$/, '')
    : DEFAULT_FIRESTORE_BASE
}

function intField(value: unknown): number {
  const v = value as { integerValue?: string; doubleValue?: number } | undefined
  if (!v) return 0
  if (typeof v.integerValue === 'string') return parseInt(v.integerValue, 10) || 0
  if (typeof v.doubleValue === 'number') return Math.round(v.doubleValue)
  return 0
}

/**
 * Lê `users/{uid}` (userPlan + tokenBudget) com cache de 60s por isolate.
 * Falha → `null` (degrada: sem gate, sem headers, sem commit em overage —
 * nunca parte o chat por causa de billing). O mesmo estado serve o gate de
 * plano do TM Speed.
 */
export async function getUserBudgetState(
  env: Env,
  userId: string,
  idToken: string,
  fetcher: Fetcher,
  now = Date.now(),
): Promise<UserBudgetState | null> {
  const cached = stateCache.get(userId)
  if (cached && cached.expiresAt > now) return cached.state

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId || !idToken) return null

  const mask = [
    'userPlan',
    'tokenBudget.tokensConsumed',
    'tokenBudget.extraUsageBalance',
    'tokenBudget.cycleEnd',
  ].map(p => `mask.fieldPaths=${encodeURIComponent(p)}`).join('&')
  const url = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(userId)}?${mask}`

  let state: UserBudgetState | null = null
  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const response = await fetcher.fetch(url, { method: 'GET', headers })
    if (response.ok) {
      const doc = await response.json() as {
        fields?: {
          userPlan?: { stringValue?: string }
          tokenBudget?: { mapValue?: { fields?: Record<string, unknown> } }
        }
      }
      const plan = doc.fields?.userPlan?.stringValue
      const budget = doc.fields?.tokenBudget?.mapValue?.fields ?? {}
      if (typeof plan === 'string' && plan) {
        state = {
          plan,
          tokensConsumed: Math.max(0, intField(budget['tokensConsumed'])),
          extraUsageBalance: Math.max(0, intField(budget['extraUsageBalance'])),
          cycleEnd: (budget['cycleEnd'] as { stringValue?: string } | undefined)?.stringValue ?? '',
        }
      }
    }
  } catch {
    state = null
  }

  stateCache.set(userId, { state, expiresAt: now + STATE_CACHE_MS })
  return state
}

/** Avança a cache local depois de um commit para que turnos consecutivos do
 *  agent loop vejam o consumo a crescer sem reler o Firestore. */
export function bumpCachedConsumption(userId: string, rawTokens: number, asOverage: boolean): void {
  const cached = stateCache.get(userId)
  if (!cached?.state) return
  cached.state.tokensConsumed += rawTokens
  if (asOverage) {
    cached.state.extraUsageBalance = Math.max(0, cached.state.extraUsageBalance - rawTokens)
  }
}

// ── Cost budget check (porte do control-plane billing.ts) ────────────────

export type CostBudgetStatus =
  | 'allowed'
  | 'allowed_warning'
  | 'allowed_critical'
  | 'allowed_overage'
  | 'rejected'

export interface CostBudgetCheck {
  allowed: boolean
  status: CostBudgetStatus
  consumedPct: number
  tokenBudget: number
  asOverage: boolean
}

const BUDGET_WARNING_THRESHOLD = 0.8
const BUDGET_CRITICAL_THRESHOLD = 0.95

export function checkCostBudget(state: UserBudgetState, budgets: Record<string, number>): CostBudgetCheck {
  const tokenBudget = budgets[state.plan] ?? 0
  const tokensConsumed = Math.max(0, state.tokensConsumed)
  const overageAvailable = Math.max(0, state.extraUsageBalance)

  // Plano sem orçamento (byok-only / desconhecido) — fail-safe: rejeita em
  // enforce; em shadow apenas reporta.
  if (tokenBudget <= 0) {
    return { allowed: false, status: 'rejected', consumedPct: 0, tokenBudget, asOverage: false }
  }

  const consumedPct = tokensConsumed / tokenBudget
  if (consumedPct >= 1) {
    if (overageAvailable > 0) {
      return { allowed: true, status: 'allowed_overage', consumedPct, tokenBudget, asOverage: true }
    }
    return { allowed: false, status: 'rejected', consumedPct, tokenBudget, asOverage: false }
  }
  if (consumedPct >= BUDGET_CRITICAL_THRESHOLD) {
    return { allowed: true, status: 'allowed_critical', consumedPct, tokenBudget, asOverage: false }
  }
  if (consumedPct >= BUDGET_WARNING_THRESHOLD) {
    return { allowed: true, status: 'allowed_warning', consumedPct, tokenBudget, asOverage: false }
  }
  return { allowed: true, status: 'allowed', consumedPct, tokenBudget, asOverage: false }
}

// ── Commit (porte do control-plane commitTokenConsumption) ───────────────

export interface CommitArgs {
  env: Env
  userId: string
  idToken: string
  rawTokens: number
  asOverage: boolean
  fetcher: Fetcher
}

export async function commitTokenConsumption(args: CommitArgs): Promise<boolean> {
  const { env, userId, idToken, rawTokens, asOverage, fetcher } = args
  if (rawTokens <= 0) return true

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return false

  const docName = `projects/${projectId}/databases/(default)/documents/users/${userId}`
  const commitUrl = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents:commit`

  // tokensConsumed cresce SEMPRE (também em overage) para o consumedPct do UI
  // passar de 1.0 monotonicamente — mesma semântica do control-plane.
  const transforms: Array<Record<string, unknown>> = [{
    fieldPath: 'tokenBudget.tokensConsumed',
    increment: { integerValue: String(rawTokens) },
  }]
  if (asOverage) {
    transforms.push({
      fieldPath: 'tokenBudget.extraUsageBalance',
      increment: { integerValue: String(-rawTokens) },
    })
  }

  const writes: Array<Record<string, unknown>> = [{
    transform: { document: docName, fieldTransforms: transforms },
  }]
  // Floor do extraUsageBalance a 0 — overages concorrentes não podem deixar
  // saldo negativo. Transform separado para correr DEPOIS do increment.
  if (asOverage) {
    writes.push({
      transform: {
        document: docName,
        fieldTransforms: [{
          fieldPath: 'tokenBudget.extraUsageBalance',
          maximum: { integerValue: '0' },
        }],
      },
    })
  }

  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const response = await fetcher.fetch(commitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[billing] commit failed (${response.status}) user=${userId} tokens=${rawTokens}: ${text.slice(0, 200)}`)
      return false
    }
    bumpCachedConsumption(userId, rawTokens, asOverage)
    return true
  } catch (error) {
    console.error('[billing] commit threw:', error)
    return false
  }
}
