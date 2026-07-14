import assert from 'node:assert/strict'
import test from 'node:test'
import { checkTeamByokBudget } from '../src/billing'

/**
 * Gate do Team BYOK (orçamento virtual opt-in): hard cap ESTRITO sobre a pool
 * bruta da equipa. BYOK não usa percentAllocation; todos os membros consomem
 * da mesma pool. Esta é a função que o index.ts usa para recusar (402) um
 * pedido ANTES do upstream, por isso a matemática tem de bater certo.
 */

function team(over: Partial<{ percentAllocation: number; byokTeamConsumed: number; byokMemberConsumed: number }>) {
  return {
    teamId: 'T1',
    purchasedExtra: 0,
    percentAllocation: 0.5,
    byokTeamConsumed: 0,
    byokMemberConsumed: 0,
    ...over,
  }
}

test('allows while the shared team pool has room', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 0.5, byokMemberConsumed: 100_000, byokTeamConsumed: 200_000 }))
  assert.equal(g.allowed, true)
  assert.equal(g.poolRemaining, 800_000)
})

test('does not block when the member Team slice would be spent', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 0.3, byokMemberConsumed: 300_000, byokTeamConsumed: 300_000 }))
  assert.equal(g.allowed, true)
  assert.equal(g.poolRemaining, 700_000)
})

test('blocks with reason "team" when the whole pool is spent', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 1, byokMemberConsumed: 0, byokTeamConsumed: 1_000_000 }))
  assert.equal(g.allowed, false)
  assert.equal(g.reason, 'team')
  assert.equal(g.poolRemaining, 0)
})

test('allows a member with 0% Team allocation while the BYOK pool has room', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 0, byokMemberConsumed: 0, byokTeamConsumed: 0 }))
  assert.equal(g.allowed, true)
  assert.equal(g.poolRemaining, 1_000_000)
})

test('ignores malformed allocation because BYOK is pool-only', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 5, byokMemberConsumed: 999_999, byokTeamConsumed: 999_999 }))
  assert.equal(g.allowed, true)
  assert.equal(g.poolRemaining, 1)
})
