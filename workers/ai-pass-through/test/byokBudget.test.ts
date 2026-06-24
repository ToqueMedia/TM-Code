import assert from 'node:assert/strict'
import test from 'node:test'
import { checkTeamByokBudget } from '../src/billing'

/**
 * Gate do Team BYOK (orçamento virtual opt-in): hard cap ESTRITO. O membro só
 * usa a sua fatia (percentAllocation × pool) e a equipa nunca passa a pool.
 * Bloqueia quando qualquer um esgota. Esta é a função que o index.ts usa para
 * recusar (402) um pedido ANTES do upstream, por isso a matemática tem de bater
 * certo em todos os casos.
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

test('allows when under both the member slice and the team pool', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 0.5, byokMemberConsumed: 100_000, byokTeamConsumed: 200_000 }))
  assert.equal(g.allowed, true)
  assert.equal(g.memberRemaining, 400_000) // 0.5 * 1M - 100k
  assert.equal(g.poolRemaining, 800_000)
})

test('blocks with reason "member" when the slice is spent (pool still has room)', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 0.3, byokMemberConsumed: 300_000, byokTeamConsumed: 300_000 }))
  assert.equal(g.allowed, false)
  assert.equal(g.reason, 'member')
  assert.equal(g.memberRemaining, 0)
  assert.ok(g.poolRemaining > 0)
})

test('blocks with reason "team" when the whole pool is spent (checked first)', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 1, byokMemberConsumed: 0, byokTeamConsumed: 1_000_000 }))
  assert.equal(g.allowed, false)
  assert.equal(g.reason, 'team')
  assert.equal(g.poolRemaining, 0)
})

test('a member with 0% allocation is blocked (slice ceiling is 0)', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 0, byokMemberConsumed: 0, byokTeamConsumed: 0 }))
  assert.equal(g.allowed, false)
  assert.equal(g.reason, 'member')
  assert.equal(g.memberRemaining, 0)
})

test('clamps a malformed allocation (>1) to the full pool', () => {
  const g = checkTeamByokBudget(1_000_000, team({ percentAllocation: 5, byokMemberConsumed: 999_999, byokTeamConsumed: 999_999 }))
  assert.equal(g.allowed, true) // ceiling clamps to pool (1M), 1 token left
  assert.equal(g.memberRemaining, 1)
})
