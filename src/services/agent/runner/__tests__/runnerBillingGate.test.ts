/**
 * Desistência do runner headless por falta de consumo.
 *
 * O caso real: a 2026-08-07 duas corridas dos evals ficaram 900s cada em
 * silêncio porque o portão de billing do `useQueueProcessor` segura a fila à
 * espera de um humano — que num processo headless não existe. As duas
 * propriedades que interessam são simétricas: **desistir** quando não há
 * créditos, e **não desistir** por causa de um estado de billing em cache que
 * o /v1/me do arranque ainda vai corrigir.
 */
import {
  BILLING_ABORT_GRACE_MS,
  shouldAbortForBilling,
} from '../runnerBillingGate'

const DEPOIS = BILLING_ABORT_GRACE_MS + 1
const DENTRO = BILLING_ABORT_GRACE_MS - 1

describe('shouldAbortForBilling', () => {
  it('desiste quando não há créditos e a carência passou', () => {
    expect(shouldAbortForBilling({ noCredits: true }, DEPOIS)).toBe(true)
  })

  it('desiste com status `rejected`, mesmo sem a flag', () => {
    expect(shouldAbortForBilling({ noCredits: false, status: 'rejected' }, DEPOIS)).toBe(true)
  })

  // A propriedade que protege corridas legítimas: o billingStore arranca da
  // cache e só o /v1/me o corrige.
  it('NÃO desiste dentro da carência — a cache pode estar velha', () => {
    expect(shouldAbortForBilling({ noCredits: true }, DENTRO)).toBe(false)
    expect(shouldAbortForBilling({ noCredits: true }, 0)).toBe(false)
  })

  it.each([
    ['activo', { noCredits: false, status: 'active' }],
    ['sem status', { noCredits: false }],
    ['status nulo', { noCredits: false, status: null }],
  ])('nunca desiste com billing saudável (%s), por muito que demore', (_l, billing) => {
    expect(shouldAbortForBilling(billing, 60 * 60_000)).toBe(false)
  })

  it('aceita uma carência explícita', () => {
    expect(shouldAbortForBilling({ noCredits: true }, 500, 100)).toBe(true)
    expect(shouldAbortForBilling({ noCredits: true }, 50, 100)).toBe(false)
  })
})
