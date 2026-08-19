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
 *   3. `commitConsumption` — increment atómico do contador do ciclo
 *      (+ decremento do `tokenBudget.extraUsageBalance` com floor a 0 em
 *      overage), via `ctx.waitUntil` depois do stream terminar.
 *
 * UNIDADES (decisão de produto 2026-08-11 — metering 30/70):
 *   • Planos PAGOS (vibe/pro/max/team-*) contam-se em MICRODÓLARES (µ$) de
 *     CUSTO REAL do provider — cache hit ao preço de cache, miss ao preço
 *     cheio, output ao preço de output (pricing.ts). Sem multiplicadores de
 *     persona nem de speed: a margem de 30% vive no preço do plano; os 70%
 *     restantes são o envelope que o utilizador consome exactamente ao custo.
 *     Campos: `tokenBudget.costConsumed` + `lifetimeCostConsumed`.
 *   • O plano EXPLORER mantém-se em TOKENS (1,5M por ciclo, sem desconto de
 *     cache nem multiplicadores — contador simples de tokens reais). Campos:
 *     `tokenBudget.tokensConsumed` + `lifetimeTokensConsumed` (os antigos —
 *     o explorer nunca migra de unidade).
 *   As duas unidades NUNCA se misturam num utilizador: o campo lido/escrito
 *   escolhe-se pelo plano resolvido no pré-voo (`planMeteringUnit`).
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

/**
 * Budgets por plano, na UNIDADE de cada plano (ver planMeteringUnit):
 * explorer em TOKENS; todos os outros em MICRODÓLARES (µ$ = 1e-6 USD).
 *
 * Envelopes 30/70 (decisão 2026-08-11, preços $10/$25/$100): o utilizador
 * consome 70% do preço a custo real → $7 / $17,50 / $70 = 7M / 17,5M / 70M µ$.
 */
const DEFAULT_PLAN_BUDGETS: Record<string, number> = {
  explorer: 1_500_000, // TOKENS — o único plano que mantém a unidade antiga
  vibe: 7_000_000, // µ$ ($7,00)
  pro: 17_500_000, // µ$ ($17,50)
  max: 70_000_000, // µ$ ($70,00)
  // PROVISÓRIO (2026-08-11): equivalência de custo da antiga allowance de
  // 32,5M tokens (~$22,40 a ρ≈$0,69/M) até decisão de produto sobre o trial.
  welcome: 22_400_000, // µ$ ($22,40)
  'toque-media': 25_000_000, // µ$ ($25,00) — 100% do notional, sem margem 30/70
  'byok-only': 0,
  // Tiers de equipa (Plano de Equipas): o budget base da "pie" partilhada. Só
  // fallback — o valor real vem do subscription_plans do admin (planKey
  // 'team-pro'/'team-max'), igual aos planos pessoais.
  'team-pro': 17_500_000, // µ$
  'team-max': 70_000_000, // µ$
}

/** Unidade de metering do plano — escolhe o campo lido/escrito no Firestore. */
export type MeteringUnit = 'tokens' | 'micros'

export function planMeteringUnit(plan: string | undefined): MeteringUnit {
  return plan === 'explorer' ? 'tokens' : 'micros'
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

let warnedBillingDisabled = false

export function resolveEnforcementMode(env: Env): BudgetEnforcementMode {
  const raw = typeof env.BUDGET_ENFORCEMENT === 'string' ? env.BUDGET_ENFORCEMENT.toLowerCase() : ''
  const configured: BudgetEnforcementMode =
    raw === 'off' || raw === 'enforce' ? raw : 'shadow'
  if (configured === 'off') return 'off'

  // Desde o fecho das Security Rules (2026-06-11), o billing contra o
  // Firestore REAL exige service account: o fallback por ID token do
  // utilizador é negado nas escritas de tokenBudget (rules) e nas leituras
  // REST (App Check enforcement) → 403 PERMISSION_DENIED por pedido, zero
  // contabilidade e spam de erros — o sintoma clássico do wrangler dev sem
  // secrets no .dev.vars. Sem SA, desligar o billing LIMPA e RUIDOSAMENTE
  // é o único comportamento honesto.
  //
  // O sinal de "alvo não-produção" é EXCLUSIVAMENTE FIRESTORE_REST_BASE
  // (emulador) ou test_static (fetcher mockado). AUTH_MODE=firebase_emulator
  // sozinho NÃO chega: diz como validamos o JWT do user, não para onde vão
  // as escritas — o .dev.vars típico tem firebase_emulator sem REST_BASE e
  // o billing batia no Firestore de PRODUÇÃO com token de emulador (403
  // garantido, o bug original deste gate).
  const hasServiceAccount =
    typeof env.FIREBASE_CLIENT_EMAIL === 'string' && env.FIREBASE_CLIENT_EMAIL !== '' &&
    typeof env.FIREBASE_PRIVATE_KEY === 'string' && env.FIREBASE_PRIVATE_KEY !== ''
  const userTokenPathUsable =
    env.AUTH_MODE === 'test_static' ||
    (typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE !== '')

  if (!hasServiceAccount && !userTokenPathUsable) {
    if (!warnedBillingDisabled) {
      warnedBillingDisabled = true
      console.warn(
        '[billing] DISABLED: FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY ausentes e o Firestore real ' +
        'nega o caminho por ID token (Security Rules + App Check). Para billing em dev local, adiciona ' +
        'os secrets da service account ao .dev.vars; para silenciar de propósito, BUDGET_ENFORCEMENT=off.',
      )
    }
    return 'off'
  }

  return configured
}

/** Reset do aviso único — usado pelos testes. */
export function resetBillingDisabledWarning(): void {
  warnedBillingDisabled = false
}

// ── Fim dos multiplicadores (2026-08-11, metering 30/70) ──────────────────
// resolveSpeedMultiplier, resolveCacheBillingFactor e billableTokenTotal
// foram REMOVIDOS: o consumo passou a ser o custo REAL do provider em µ$
// (pricing.ts) e não há multiplicador nenhum entre o custo e o contador.
// O costMultiplier da persona deixou de existir no billing (a persona decide
// só o modelo; o preço do modelo É a diferenciação de consumo). O TM Speed
// mantém o gate de elegibilidade (planGate) mas já não multiplica nada.
//
// História preservada de propósito: o factor de cache anterior (0,50→0,43)
// calibrava margens sobre uma unidade abstracta; a doutrina actual torna a
// calibração desnecessária — margem fixa de 30% no preço do plano, envelope
// de 70% a passe-a-custo, para qualquer cache rate, provider ou mix.

/**
 * Tokens reais para o plano EXPLORER (o único que mantém a unidade antiga):
 * prompt + completion, sem desconto de cache nem multiplicadores — um
 * contador simples e explicável para o tier gratuito.
 */
export function explorerTokenTotal(usage: {
  promptTokens: number
  completionTokens: number
}): number {
  return Math.max(0, usage.promptTokens) + Math.max(0, usage.completionTokens)
}

// ── User budget state (cached read) ──────────────────────────────────────

/** Membro de uma equipa (Plano de Equipas). Presente em `UserBudgetState.team`
 *  quando `users/{uid}.activeTeamId` aponta para uma equipa — nesse caso o
 *  gate e o commit usam a FATIA do membro (hard cap ESTRITO), não o budget
 *  pessoal. A pie = budget base do tier + `purchasedExtra`; o teto do membro =
 *  `percentAllocation × pieTotal`. Σ fatias ≤ 100% garante que a equipa não
 *  estoura a pie, por isso nunca há overage no modelo de equipa. */
export interface TeamMemberBudget {
  teamId: string
  /** Tokens comprados avulsos (`teams/{id}.tokenBudget.purchasedExtra`) que
   *  CRESCEM a pie — não é um pool de overflow consumível. */
  purchasedExtra: number
  /** Fatia do membro (0..1). */
  percentAllocation: number
  /** Team BYOK virtual ledger (raw 1x tokens) — usado SÓ quando a config
   *  team:{teamId} tem `pool > 0`. Independente do budget gerido por ciclo;
   *  byokMemberConsumed é apenas telemetria por membro, não gate. */
  byokTeamConsumed: number
  byokMemberConsumed: number
}

export interface UserBudgetState {
  /**
   * `users.userPlan` pessoal — NUNCA remapeado pela pie. O lock Toque Media
   * (force/deny `persona:tm`) lê isto, não `plan`.
   */
  personalPlan: string
  plan: string
  /** Consumo do ciclo, na unidade do plano (`unit`). */
  consumed: number
  /** Unidade de metering do plano (explorer=tokens; pagos=µ$). */
  unit: MeteringUnit
  extraUsageBalance: number
  cycleEnd: string
  /** Cap por utilizador que SUBSTITUI o budget do plano quando presente
   *  (gifts do admin — `tokenBudget.tokenBudgetOverride` no Firestore).
   *  Sem isto, um gift com override acima do budget do plano levava 402
   *  indevido em enforce; abaixo, sub-enforçava. */
  tokenBudgetOverride?: number
  /** Conta suspensa por um admin (`users/{uid}.blocked`, campo de topo). O
   *  gate rejeita o pedido com 403 antes do upstream. */
  blocked?: boolean
  /** Soft-delete por um admin (`users/{uid}.deleted`, campo de topo). Mesmo
   *  efeito do `blocked` no gate. */
  deleted?: boolean
  /** Quando presente, o consumo vem de uma equipa: `plan` é o tier, os campos
   *  de topo já estão projetados na fatia do membro (`tokensConsumed` =
   *  consumo do membro, `extraUsageBalance` = 0), e o gate/commit usam este
   *  bloco. Ver [[PLAN-TEAM-PLAN-BILLING]]. */
  team?: TeamMemberBudget
}

const STATE_CACHE_MS = 60_000
/** TTL curto para utilizadores que o gate viu perto/em cima do limite. */
const NEAR_LIMIT_STATE_CACHE_MS = 10_000
let stateCache = new Map<string, { state: UserBudgetState | null; expiresAt: number }>()

export function clearBudgetStateCache(): void {
  stateCache = new Map()
}

/**
 * Encurta a validade da cache do estado de orçamento deste utilizador para
 * ≤10s. Chamado pelo gate quando o pedido foi visto perto do limite
 * (allowed_critical / allowed_overage) ou já rejeitado. Duas razões:
 *
 *  1. Overshoot concorrente — com N runs em paralelo (multi-janela na IDE),
 *     a cache de 60s admitia até 60s de pedidos sobre um snapshot velho; o
 *     overshoot cresce com o paralelismo. Perto do limite, o snapshot tem de
 *     envelhecer depressa para os commits (deste e de outros isolates, via
 *     re-read do Firestore) travarem a tempo.
 *  2. Desbloqueio pós-compra — uma rejeição cacheada "colava" por até 60s
 *     depois de o utilizador comprar consumo extra; com TTL curto o próximo
 *     pedido relê o saldo novo em ≤10s.
 *
 * Só encurta — nunca alonga — e não toca no caminho feliz (longe do limite
 * mantém o TTL barato de 60s).
 */
export function shortenBudgetStateCacheTtl(userId: string, now = Date.now()): void {
  const cached = stateCache.get(userId)
  if (!cached) return
  const cap = now + NEAR_LIMIT_STATE_CACHE_MS
  if (cached.expiresAt > cap) {
    stateCache.set(userId, { state: cached.state, expiresAt: cap })
  }
}

const DEFAULT_FIRESTORE_BASE = 'https://firestore.googleapis.com'

// Um stall do Firestore não pode pendurar o pedido (a leitura corre no
// pré-voo, antes da resposta) nem o waitUntil do commit — timeouts curtos;
// os throws caem nos try/catch existentes e degradam como qualquer outra
// falha de billing. O commit tem mais folga porque já não bloqueia ninguém.
const FIRESTORE_READ_TIMEOUT_MS = 10_000
const FIRESTORE_COMMIT_TIMEOUT_MS = 15_000

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

/** Como `intField` mas SEM arredondar — para frações (ex. percentAllocation
 *  0..1, normalmente um doubleValue). Arredondar uma fatia destruía-a. */
function numField(value: unknown): number {
  const v = value as { integerValue?: string; doubleValue?: number } | undefined
  if (!v) return 0
  if (typeof v.doubleValue === 'number') return v.doubleValue
  if (typeof v.integerValue === 'string') return parseFloat(v.integerValue) || 0
  return 0
}

/** uid como segmento de FieldPath do Firestore: backtick-quote (um uid pode
 *  começar por dígito, o que exige aspas no path de máscaras e transforms). */
function fieldPathSegment(key: string): string {
  return '`' + key.replace(/([\\`])/g, '\\$1') + '`'
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

  // Os DOIS contadores de ciclo na máscara: o plano resolve qual se lê
  // (planMeteringUnit) — o explorer mantém `tokensConsumed` (tokens), os
  // planos pagos lêem `costConsumed` (µ$, migração 2026-08-11).
  const mask = [
    'userPlan',
    'activeTeamId',
    'blocked',
    'deleted',
    'tokenBudget.tokensConsumed',
    'tokenBudget.costConsumed',
    'tokenBudget.extraUsageBalance',
    'tokenBudget.cycleEnd',
    'tokenBudget.tokenBudgetOverride',
  ].map(p => `mask.fieldPaths=${encodeURIComponent(p)}`).join('&')
  const url = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(userId)}?${mask}`

  let state: UserBudgetState | null = null
  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const response = await fetcher.fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FIRESTORE_READ_TIMEOUT_MS),
    })
    if (response.ok) {
      const doc = await response.json() as {
        fields?: {
          userPlan?: { stringValue?: string }
          activeTeamId?: { stringValue?: string }
          blocked?: { booleanValue?: boolean }
          deleted?: { booleanValue?: boolean }
          tokenBudget?: { mapValue?: { fields?: Record<string, unknown> } }
        }
      }
      const userBlocked = doc.fields?.blocked?.booleanValue === true
      const userDeleted = doc.fields?.deleted?.booleanValue === true
      const activeTeamId = doc.fields?.activeTeamId?.stringValue
      const plan = doc.fields?.userPlan?.stringValue
      const budget = doc.fields?.tokenBudget?.mapValue?.fields ?? {}

      if (typeof activeTeamId === 'string' && activeTeamId) {
        // Membro de uma equipa: a fatia hard-cap SUBSTITUI o budget pessoal.
        // Segunda leitura (teams/{id}) que entra no mesmo estado cacheado 60s.
        const team = await getTeamMemberBudget(env, activeTeamId, userId, idToken, fetcher)
        if (team) {
          state = {
            personalPlan: typeof plan === 'string' && plan ? plan : '',
            plan: team.planTier,
            consumed: team.memberConsumed,
            // Tiers de equipa são sempre pagos → µ$.
            unit: 'micros',
            extraUsageBalance: 0,
            cycleEnd: team.cycleEnd,
            blocked: userBlocked || team.memberBlocked,
            deleted: userDeleted,
            team: {
              teamId: activeTeamId,
              purchasedExtra: team.purchasedExtra,
              percentAllocation: team.percentAllocation,
              byokTeamConsumed: team.byokTeamConsumed,
              byokMemberConsumed: team.byokMemberConsumed,
            },
          }
        }
        // team null (equipa apagada / não-membro / leitura falhada) → cai no
        // plano PESSOAL abaixo (M1), nunca bloqueia o user com fatia 0.
      }
      if (!state && typeof plan === 'string' && plan) {
        const overrideRaw = intField(budget['tokenBudgetOverride'])
        // Campo do ciclo pela unidade do plano. Fallback defensivo para o
        // lado µ$: doc ainda sem `costConsumed` (pré-migração) lê o contador
        // antigo — valores em unidade errada só são possíveis na janela entre
        // o deploy do worker e a migração do control-plane, e o reset geral
        // da migração zera-os a seguir.
        const unit = planMeteringUnit(plan)
        const consumed = unit === 'tokens'
          ? intField(budget['tokensConsumed'])
          : (budget['costConsumed'] !== undefined
            ? intField(budget['costConsumed'])
            : intField(budget['tokensConsumed']))
        state = {
          personalPlan: plan,
          plan,
          consumed: Math.max(0, consumed),
          unit,
          extraUsageBalance: Math.max(0, intField(budget['extraUsageBalance'])),
          cycleEnd: (budget['cycleEnd'] as { stringValue?: string } | undefined)?.stringValue ?? '',
          tokenBudgetOverride: overrideRaw > 0 ? overrideRaw : undefined,
          blocked: userBlocked,
          deleted: userDeleted,
        }
      }
    } else {
      // Degradação é deliberadamente silenciosa para o chat, mas tem de ser
      // VISÍVEL nos logs — um PEM mal formatado ou rules a negar a leitura
      // tornariam o billing um no-op sem nenhum sinal.
      const text = await response.text().catch(() => '')
      console.warn(`[billing] budget read failed (${response.status}) user=${userId}: ${text.slice(0, 200)}`)
    }
  } catch (error) {
    console.warn('[billing] budget read threw:', error)
    state = null
  }

  stateCache.set(userId, { state, expiresAt: now + STATE_CACHE_MS })
  return state
}

// ── Team member budget (Plano de Equipas) ────────────────────────────────
//
// Quando `users/{uid}.activeTeamId` aponta para uma equipa, o consumo vem da
// FATIA do membro nessa equipa, não do plano pessoal. Lê `teams/{teamId}` com
// uma máscara mínima: o tier (→ budget base via resolvePlanBudgetFor), o
// `purchasedExtra` (top-ups avulsos que crescem a pie), e o submapa
// `members.{uid}` (fatia + consumo + bloqueio). Hard cap ESTRITO: a fatia é o
// teto, nunca há overage. Falha/ausência → null (degrada como qualquer leitura
// de billing). Corre dentro do getUserBudgetState, por isso partilha a cache.

interface TeamMemberRead {
  planTier: string
  purchasedExtra: number
  percentAllocation: number
  memberConsumed: number
  memberBlocked: boolean
  cycleEnd: string
  /** Team BYOK virtual ledger (independent of the cycle-based managed budget):
   *  the team total + this member's observed usage. Both raw (1x) tokens. */
  byokTeamConsumed: number
  byokMemberConsumed: number
}

async function getTeamMemberBudget(
  env: Env,
  teamId: string,
  userId: string,
  idToken: string,
  fetcher: Fetcher,
): Promise<TeamMemberRead | null> {
  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId || !teamId || !idToken) return null

  const mask = [
    'planTier',
    'subscription',
    'tokenBudget.purchasedExtra',
    'cycle.cycleEnd',
    'byokBudget.consumed',
    `members.${fieldPathSegment(userId)}`,
  ].map(p => `mask.fieldPaths=${encodeURIComponent(p)}`).join('&')
  const url = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents/teams/${encodeURIComponent(teamId)}?${mask}`

  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const response = await fetcher.fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FIRESTORE_READ_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.warn(`[billing] team read failed (${response.status}) team=${teamId} user=${userId}: ${text.slice(0, 200)}`)
      return null
    }
    const doc = await response.json() as {
      fields?: {
        planTier?: { stringValue?: string }
        subscription?: { mapValue?: { fields?: Record<string, unknown> } }
        tokenBudget?: { mapValue?: { fields?: Record<string, unknown> } }
        cycle?: { mapValue?: { fields?: Record<string, unknown> } }
        byokBudget?: { mapValue?: { fields?: Record<string, unknown> } }
        members?: { mapValue?: { fields?: Record<string, unknown> } }
      }
    }
    const planTier = doc.fields?.planTier?.stringValue
    if (typeof planTier !== 'string' || !planTier) return null

    // Subscrição da equipa: sem plano pago ATIVO (ou expirado) a equipa não dá
    // pie — null → o membro cai no plano PESSOAL (M1). Fecha o furo de criar
    // equipa grátis e ganhar o budget do tier sem pagar.
    const sub = doc.fields?.subscription?.mapValue?.fields ?? {}
    const subActive = (sub['active'] as { booleanValue?: boolean } | undefined)?.booleanValue === true
    const subExpiresAt = (sub['expiresAt'] as { stringValue?: string } | undefined)?.stringValue ?? ''
    if (!subActive || (subExpiresAt !== '' && Date.parse(subExpiresAt) < Date.now())) return null

    const tb = doc.fields?.tokenBudget?.mapValue?.fields ?? {}
    const cycle = doc.fields?.cycle?.mapValue?.fields ?? {}
    const byok = doc.fields?.byokBudget?.mapValue?.fields ?? {}
    const members = doc.fields?.members?.mapValue?.fields ?? {}
    const memberRaw = members[userId] as { mapValue?: { fields?: Record<string, unknown> } } | undefined
    // M1: activeTeamId aponta para uma equipa onde o user NÃO é membro (removido
    // mas activeTeamId por limpar) → null, e o getUserBudgetState cai no plano
    // pessoal em vez de o bloquear com fatia 0.
    if (!memberRaw) return null
    const member = memberRaw.mapValue?.fields ?? {}
    return {
      planTier,
      purchasedExtra: Math.max(0, intField(tb['purchasedExtra'])),
      percentAllocation: Math.min(1, Math.max(0, numField(member['percentAllocation']))),
      // Tiers de equipa são pagos → µ$ (`costConsumed`); fallback ao campo
      // antigo só cobre a janela pré-migração (o reset geral zero-a).
      memberConsumed: Math.max(0, member['costConsumed'] !== undefined
        ? intField(member['costConsumed'])
        : intField(member['tokensConsumed'])),
      memberBlocked: (member['blocked'] as { booleanValue?: boolean } | undefined)?.booleanValue === true,
      cycleEnd: (cycle['cycleEnd'] as { stringValue?: string } | undefined)?.stringValue ?? '',
      byokTeamConsumed: Math.max(0, intField(byok['consumed'])),
      byokMemberConsumed: Math.max(0, intField(member['byokConsumed'])),
    }
  } catch (error) {
    console.warn('[billing] team read threw:', error)
    return null
  }
}

// ── Plan budget (admin-set em subscription_plans) ────────────────────────
//
// O budget VERDADEIRO de um plano é o que o admin define na web
// (subscription_plans/{doc}.tokenBudget — docs com ID auto-gerado, o nome do
// plano vive no campo `planKey`; mesmo lookup do getPlanConfig do
// control-plane). O mapa hardcoded/PLAN_BUDGETS_JSON passa a ser APENAS
// fallback — sem esta leitura, o worker bloqueava (402) utilizadores ao
// atingir o valor hardcoded mesmo quando o admin tinha publicado um budget
// maior (visto em produção 2026-06-12: web 25% vs IDE 59% no mesmo user).
// Cache de 5 min por isolate: mudanças de pricing são raras e ~1 query/5min/
// plano é ruído; falha de leitura degrada para o fallback, nunca parte o chat.

const PLAN_BUDGET_CACHE_MS = 300_000
let planBudgetCache = new Map<string, { budget: number | null; expiresAt: number }>()

export function clearPlanBudgetCache(): void {
  planBudgetCache = new Map()
}

export async function resolvePlanBudgetFor(
  env: Env,
  plan: string,
  idToken: string,
  fetcher: Fetcher,
  now = Date.now(),
): Promise<number> {
  const fallback = resolvePlanBudgets(env)[plan] ?? 0

  const cached = planBudgetCache.get(plan)
  if (cached && cached.expiresAt > now) return cached.budget ?? fallback

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return fallback

  let adminBudget: number | null = null
  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const url = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents:runQuery`
    const response = await fetcher.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'subscription_plans' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'planKey' },
              op: 'EQUAL',
              value: { stringValue: plan },
            },
          },
          limit: 1,
        },
      }),
      signal: AbortSignal.timeout(FIRESTORE_READ_TIMEOUT_MS),
    })
    if (response.ok) {
      const rows = await response.json() as Array<{ document?: { fields?: Record<string, unknown> } }>
      const fields = Array.isArray(rows) ? rows.find(r => r.document)?.document?.fields : undefined
      // Migração 30/70: o admin passa a publicar o envelope em µ$ no campo
      // `costBudget`; `tokenBudget` fica como fallback até o control-plane
      // publicar no campo novo (o valor antigo em tokens NÃO é conversível —
      // mas na janela de transição o reset geral já correu, por isso o pior
      // caso é o fallback hardcoded em µ$).
      const raw = fields?.['costBudget'] !== undefined
        ? intField(fields['costBudget'])
        : intField(fields?.['tokenBudget'])
      adminBudget = raw > 0 ? raw : null
    } else {
      const text = await response.text().catch(() => '')
      console.warn(`[billing] plan budget read failed (${response.status}) plan=${plan}: ${text.slice(0, 200)}`)
    }
  } catch (error) {
    console.warn('[billing] plan budget read threw:', error)
  }

  planBudgetCache.set(plan, { budget: adminBudget, expiresAt: now + PLAN_BUDGET_CACHE_MS })
  return adminBudget ?? fallback
}

/** Avança a cache local depois de um commit para que turnos consecutivos do
 *  agent loop vejam o consumo a crescer sem reler o Firestore. `amount` vem
 *  na unidade do plano (tokens no explorer, µ$ nos pagos). */
export function bumpCachedConsumption(userId: string, amount: number, asOverage: boolean): void {
  const cached = stateCache.get(userId)
  if (!cached?.state) return
  cached.state.consumed += amount
  if (asOverage) {
    cached.state.extraUsageBalance = Math.max(0, cached.state.extraUsageBalance - amount)
  }
}

/** Como bumpCachedConsumption mas para o ledger BYOK virtual da equipa — sem
 *  isto, pedidos consecutivos dentro da janela de cache (60s) viam a pool
 *  desatualizada e podiam ultrapassar o teto antes do Firestore atualizar. */
export function bumpCachedByokConsumption(userId: string, rawTokens: number): void {
  const cached = stateCache.get(userId)
  if (!cached?.state?.team) return
  cached.state.team.byokMemberConsumed += rawTokens
  cached.state.team.byokTeamConsumed += rawTokens
}

/** Gate do Team BYOK (hard cap ESTRITO): BYOK usa uma pool bruta partilhada.
 *  Não há fatia por membro; percentAllocation só vale para o plano TM gerido.
 *  O caller só chama isto com `pool > 0`. */
export interface TeamByokGate {
  allowed: boolean
  /** 'team' = a pool total esgotou. */
  reason?: 'team'
  poolRemaining: number
}

export function checkTeamByokBudget(pool: number, team: TeamMemberBudget): TeamByokGate {
  const poolRemaining = Math.max(0, pool - team.byokTeamConsumed)
  if (poolRemaining <= 0) return { allowed: false, reason: 'team', poolRemaining }
  return { allowed: true, poolRemaining }
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
  // Membro de equipa: fatia hard-cap ESTRITA, sem overage. Ramo dedicado.
  if (state.team) return checkTeamSliceBudget(state, budgets)

  // Override por utilizador (gifts) substitui o budget do plano — mesma
  // semântica do tokenBudgetOverride na web/control-plane.
  const tokenBudget = state.tokenBudgetOverride ?? budgets[state.plan] ?? 0
  const consumed = Math.max(0, state.consumed)
  const overageAvailable = Math.max(0, state.extraUsageBalance)

  // Plano sem orçamento (byok-only / desconhecido) — fail-safe: rejeita em
  // enforce; em shadow apenas reporta.
  if (tokenBudget <= 0) {
    return { allowed: false, status: 'rejected', consumedPct: 0, tokenBudget, asOverage: false }
  }

  const consumedPct = consumed / tokenBudget
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

/**
 * Gate da fatia de um membro de equipa (hard cap ESTRITO).
 *
 * pieTotal = budget base do tier (`budgets[state.plan]`) + purchasedExtra.
 * teto do membro = percentAllocation × pieTotal. O consumo do membro já vem
 * projetado em `state.tokensConsumed`. Decisão travada (ver
 * PLAN-TEAM-PLAN-BILLING): ao atingir 100% da fatia → `rejected`, SEM overage,
 * mesmo que a equipa tenha folga — só o admin a aumentar a % desbloqueia.
 */
function checkTeamSliceBudget(state: UserBudgetState, budgets: Record<string, number>): CostBudgetCheck {
  const baseBudget = budgets[state.plan] ?? 0
  const pieTotal = Math.max(0, baseBudget + (state.team?.purchasedExtra ?? 0))
  const sliceTokens = Math.floor(pieTotal * (state.team?.percentAllocation ?? 0))
  const consumed = Math.max(0, state.consumed)

  // Fatia nula (membro sem alocação) ou tier sem budget → rejeita.
  if (sliceTokens <= 0) {
    return { allowed: false, status: 'rejected', consumedPct: 0, tokenBudget: sliceTokens, asOverage: false }
  }

  const consumedPct = consumed / sliceTokens
  if (consumedPct >= 1) {
    return { allowed: false, status: 'rejected', consumedPct, tokenBudget: sliceTokens, asOverage: false }
  }
  if (consumedPct >= BUDGET_CRITICAL_THRESHOLD) {
    return { allowed: true, status: 'allowed_critical', consumedPct, tokenBudget: sliceTokens, asOverage: false }
  }
  if (consumedPct >= BUDGET_WARNING_THRESHOLD) {
    return { allowed: true, status: 'allowed_warning', consumedPct, tokenBudget: sliceTokens, asOverage: false }
  }
  return { allowed: true, status: 'allowed', consumedPct, tokenBudget: sliceTokens, asOverage: false }
}

// ── Commit (porte do control-plane commitTokenConsumption) ───────────────

export interface CommitArgs {
  env: Env
  userId: string
  idToken: string
  /** Valor a comitar, na unidade do plano (`unit`). */
  amount: number
  /** explorer → tokens (campos antigos); restantes → µ$ (campos novos). */
  unit: MeteringUnit
  asOverage: boolean
  fetcher: Fetcher
  /** Quando presente, o commit é dual-write na EQUIPA (total + fatia do
   *  membro), não em `users/{uid}`. Hard cap estrito → nunca há overage.
   *  Equipas são sempre µ$. */
  team?: { teamId: string }
}

export async function commitConsumption(args: CommitArgs): Promise<boolean> {
  // Membro de equipa: dual-write na equipa em vez de users/{uid}.
  if (args.team) return commitTeamConsumption(args)

  const { env, userId, idToken, amount, unit, asOverage, fetcher } = args
  if (amount <= 0) return true

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return false

  const docName = `projects/${projectId}/databases/(default)/documents/users/${userId}`
  const commitUrl = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents:commit`

  // Campos pela unidade do plano: o explorer continua nos campos antigos em
  // tokens; os pagos escrevem nos campos novos em µ$ (migração 2026-08-11).
  const cycleField = unit === 'tokens' ? 'tokenBudget.tokensConsumed' : 'tokenBudget.costConsumed'
  const lifetimeField = unit === 'tokens' ? 'lifetimeTokensConsumed' : 'lifetimeCostConsumed'

  // O contador do ciclo cresce SEMPRE (também em overage) para o consumedPct
  // do UI passar de 1.0 monotonicamente — mesma semântica do control-plane.
  const transforms: Array<Record<string, unknown>> = [{
    fieldPath: cycleField,
    increment: { integerValue: String(amount) },
  }, {
    // Contador vitalício ("todos os tempos") — campo de topo, DELIBERADAMENTE
    // fora de tokenBudget para nenhum reset de ciclo / mudança de plano
    // (control-plane firestore.ts) o zerar. Cresce em cada commit, nunca
    // decrementa. O transform increment auto-cria o campo (a partir de
    // amount) nos docs que não o tenham — sem migração para users antigos.
    fieldPath: lifetimeField,
    increment: { integerValue: String(amount) },
  }]
  if (asOverage) {
    transforms.push({
      fieldPath: 'tokenBudget.extraUsageBalance',
      increment: { integerValue: String(-amount) },
    })
    // Rastreio do overage pago neste ciclo — o carry-over do reset de ciclo
    // (control-plane firestore.ts computeCarryOver) subtrai-o do overshoot
    // para o excedente já pago via saldo extra não ser cobrado duas vezes
    // no ciclo seguinte.
    transforms.push({
      fieldPath: 'tokenBudget.overageConsumed',
      increment: { integerValue: String(amount) },
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
      signal: AbortSignal.timeout(FIRESTORE_COMMIT_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[billing] commit failed (${response.status}) user=${userId} amount=${amount} unit=${unit}: ${text.slice(0, 200)}`)
      return false
    }
    // Log de sucesso deliberado (1 linha/pedido): na fase shadow é a
    // evidência de que a cadeia SA → Firestore funciona em produção; com os
    // Workers Logs persistentes ([observability] no wrangler.toml) fica
    // consultável no dashboard sem precisar de um `wrangler tail` aberto.
    console.info(`[billing] committed ${amount} ${unit === 'tokens' ? 'tokens' : 'µ$'} user=${userId} mode=${asOverage ? 'overage' : 'cycle'}`)
    bumpCachedConsumption(userId, amount, asOverage)
    return true
  } catch (error) {
    console.error('[billing] commit threw:', error)
    return false
  }
}

/**
 * Commit de consumo de uma equipa (Plano de Equipas) — dual-write ATÓMICO no
 * doc `teams/{teamId}`: total da equipa + contador vitalício + fatia do membro
 * (`members.{uid}.tokensConsumed`), num único `:commit`. Hard cap estrito →
 * NUNCA há overage, por isso é só incrementos (sem extraUsageBalance, sem
 * floor). A cache por-utilizador é avançada com a fatia do membro para os
 * turnos seguintes verem o consumo a crescer sem reler.
 */
async function commitTeamConsumption(args: CommitArgs): Promise<boolean> {
  const { env, userId, idToken, amount, fetcher, team } = args
  if (amount <= 0 || !team) return true

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return false

  const docName = `projects/${projectId}/databases/(default)/documents/teams/${team.teamId}`
  const commitUrl = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents:commit`

  // Equipas são sempre planos pagos → µ$ (campos costConsumed).
  const writes = [{
    transform: {
      document: docName,
      fieldTransforms: [
        { fieldPath: 'tokenBudget.costConsumed', increment: { integerValue: String(amount) } },
        { fieldPath: 'lifetimeCostConsumed', increment: { integerValue: String(amount) } },
        { fieldPath: `members.${fieldPathSegment(userId)}.costConsumed`, increment: { integerValue: String(amount) } },
      ],
    },
  }]

  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const response = await fetcher.fetch(commitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
      signal: AbortSignal.timeout(FIRESTORE_COMMIT_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[billing] team commit failed (${response.status}) team=${team.teamId} user=${userId} micros=${amount}: ${text.slice(0, 200)}`)
      return false
    }
    console.info(`[billing] committed ${amount} µ$ team=${team.teamId} member=${userId}`)
    bumpCachedConsumption(userId, amount, false)
    return true
  } catch (error) {
    console.error('[billing] team commit threw:', error)
    return false
  }
}

/**
 * Commit do Team BYOK — ledger VIRTUAL, totalmente separado do budget gerido
 * por ciclo. Dual-write atómico em `teams/{teamId}`: total da pool
 * (`byokBudget.consumed`) + telemetria do membro (`members.{uid}.byokConsumed`), num
 * único :commit. Tokens RAW (1x — é a despesa real do admin no provedor, sem o
 * multiplicador de billing da TM). Não toca em `lifetimeTokensConsumed` (esse é
 * o contador de uso GERIDO). Só corre em sucesso do upstream → um 502/erro do
 * provedor nunca consome (requisito do produto).
 */
export async function commitTeamByokConsumption(args: {
  env: Env
  userId: string
  idToken: string
  teamId: string
  rawTokens: number
  fetcher: Fetcher
}): Promise<boolean> {
  const { env, userId, idToken, teamId, rawTokens, fetcher } = args
  if (rawTokens <= 0 || !teamId) return true

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return false

  const docName = `projects/${projectId}/databases/(default)/documents/teams/${teamId}`
  const commitUrl = `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents:commit`

  const writes = [{
    transform: {
      document: docName,
      fieldTransforms: [
        { fieldPath: 'byokBudget.consumed', increment: { integerValue: String(rawTokens) } },
        { fieldPath: `members.${fieldPathSegment(userId)}.byokConsumed`, increment: { integerValue: String(rawTokens) } },
      ],
    },
  }]

  try {
    const headers = await resolveFirestoreAuthHeaders(env, idToken, fetcher)
    const response = await fetcher.fetch(commitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
      signal: AbortSignal.timeout(FIRESTORE_COMMIT_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[billing] team-byok commit failed (${response.status}) team=${teamId} user=${userId} tokens=${rawTokens}: ${text.slice(0, 200)}`)
      return false
    }
    console.info(`[billing] committed ${rawTokens} BYOK tokens team=${teamId} member=${userId}`)
    bumpCachedByokConsumption(userId, rawTokens)
    return true
  } catch (error) {
    console.error('[billing] team-byok commit threw:', error)
    return false
  }
}
