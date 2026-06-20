/**
 * Gate de plano para o TM Speed.
 *
 * Desde a chegada da contabilidade de billing ao data-plane (billing.ts),
 * a elegibilidade do speed deixa de ter leitura Firestore própria: deriva do
 * MESMO `UserBudgetState` cacheado (60s) que o gate de orçamento usa —
 * `users/{uid}.userPlan` vem na mesma resposta que `tokenBudget.*`, por isso
 * o speed custa zero round-trips adicionais.
 *
 * Decisões deliberadas (inalteradas):
 *  - Plano não elegível ou lookup falhado → degrada para o modelo normal em
 *    vez de 403. Um 403 partiria o chat inteiro de um utilizador que fez
 *    downgrade com `tmSpeedEnabled` ainda persistido (a IDE continua a
 *    enviar o header). Degradar é abuse-safe: o multiplicador de cobrança
 *    (3x) só é aplicado quando o speed foi REALMENTE servido — e agora é
 *    aplicado server-side no commit (billing.ts), não na IDE.
 */

import type { UserBudgetState } from './billing'
import { clearBudgetStateCache } from './billing'

// Tiers de equipa herdam a elegibilidade do plano pessoal equivalente
// (team-pro ≡ pro, team-max ≡ max). `state.plan` é o tier para membros de
// equipa (projetado em getUserBudgetState).
const SPEED_ALLOWED_PLANS = new Set(['pro', 'max', 'team-pro', 'team-max'])

/** Mantido para os testes — a cache agora vive em billing.ts. */
export function clearPlanCache(): void {
  clearBudgetStateCache()
}

export function isSpeedAllowedForPlanState(state: UserBudgetState | null): boolean {
  return !!state && SPEED_ALLOWED_PLANS.has(state.plan)
}
