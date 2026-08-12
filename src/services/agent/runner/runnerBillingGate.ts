/**
 * Quando é que um runner headless deve DESISTIR por falta de consumo.
 *
 * PORQUÊ (2026-08-07, medido)
 * ───────────────────────────
 * `useQueueProcessor` tem um portão de billing — `noCredits || status ===
 * 'rejected'` — que segura a fila à espera de que um humano compre créditos.
 * Na janela é o comportamento certo (há um banner e um botão Retomar). Num
 * processo headless não há humano nenhum, e o desfecho media-se em silêncio
 * até ao timeout duro: duas corridas dos evals gastaram **15 minutos cada** a
 * não fazer nada, com o heartbeat a imprimir `noCredits: true` de 3 em 3
 * segundos sem que nada agisse sobre isso.
 *
 * Despausar a fila não resolve — e o runner já a despausa. O portão é
 * independente da flag de pausa.
 *
 * A CARÊNCIA é o detalhe que não se pode perder: o `billingStore` arranca a
 * partir de cache (`noCredits: cached.status === 'rejected'`) e só o /v1/me do
 * arranque o corrige. Desistir ao primeiro batimento reprovaria corridas
 * legítimas por causa de um estado velho de segundos.
 */

/** Estado mínimo lido do billingStore. */
export interface BillingSnapshot {
  noCredits: boolean
  status?: string | null
}

/**
 * Tempo que se dá ao /v1/me do arranque para corrigir um estado em cache
 * antes de acreditar num "sem créditos".
 */
export const BILLING_ABORT_GRACE_MS = 10_000

export function shouldAbortForBilling(
  billing: BillingSnapshot,
  elapsedMs: number,
  graceMs: number = BILLING_ABORT_GRACE_MS,
): boolean {
  const bloqueado = billing.noCredits || billing.status === 'rejected'
  return bloqueado && elapsedMs > graceMs
}
