import assert from 'node:assert/strict'
import test from 'node:test'
import { clearBudgetStateCache, getUserBudgetState, shortenBudgetStateCacheTtl } from '../src/billing'
import type { Env, Fetcher } from '../src/types'

/**
 * TTL adaptativo da cache do estado de orçamento: perto do limite (ou já
 * rejeitado) o gate chama shortenBudgetStateCacheTtl e o snapshot passa a
 * envelhecer em ≤10s em vez de 60s — é o que trava o overshoot de N runs
 * paralelos e desbloqueia compras de extra sem esperar o minuto. Estes testes
 * exercitam a mecânica da cache; a decisão de QUANDO encurtar vive no
 * index.ts (status allowed_critical/allowed_overage/rejected).
 */

function makeEnv(): Env {
  return { FIREBASE_PROJECT_ID: 'test-project' } as unknown as Env
}

/** Fetcher que conta leituras ao Firestore e responde sempre 500 — o estado
 *  cacheado fica `null` (degradação), mas a mecânica de TTL é a mesma. */
function makeFetcher() {
  const counter = { firestoreReads: 0 }
  const fetcher: Fetcher = {
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('firestore')) counter.firestoreReads++
      return new Response('unavailable', { status: 500 })
    },
  } as unknown as Fetcher
  return { fetcher, counter }
}

const T0 = 1_750_000_000_000

test('state is cached for 60s per user', async () => {
  clearBudgetStateCache()
  const { fetcher, counter } = makeFetcher()
  const env = makeEnv()

  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0)
  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0 + 30_000)
  assert.equal(counter.firestoreReads, 1)

  // Sem encurtar, aos 59s ainda é cache; aos 61s expira.
  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0 + 59_000)
  assert.equal(counter.firestoreReads, 1)
  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0 + 61_000)
  assert.equal(counter.firestoreReads, 2)
})

test('shorten caps the TTL at ~10s so a near-limit user re-reads early', async () => {
  clearBudgetStateCache()
  const { fetcher, counter } = makeFetcher()
  const env = makeEnv()

  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0)
  assert.equal(counter.firestoreReads, 1)

  shortenBudgetStateCacheTtl('u1', T0)

  // Dentro dos 10s continua servida da cache…
  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0 + 9_000)
  assert.equal(counter.firestoreReads, 1)
  // …aos 11s já relê o Firestore (sem o shorten seriam 60s).
  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0 + 11_000)
  assert.equal(counter.firestoreReads, 2)
})

test('shorten never EXTENDS an entry that is about to expire', async () => {
  clearBudgetStateCache()
  const { fetcher, counter } = makeFetcher()
  const env = makeEnv()

  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0)
  // Entrada expira em T0+60s; aos 55s o cap seria 55+10=65s — NÃO pode esticar.
  shortenBudgetStateCacheTtl('u1', T0 + 55_000)
  await getUserBudgetState(env, 'u1', 'tok', fetcher, T0 + 61_000)
  assert.equal(counter.firestoreReads, 2)
})

test('shorten is a safe no-op for users with nothing cached', () => {
  clearBudgetStateCache()
  shortenBudgetStateCacheTtl('ghost')
})

test('shorten only affects the targeted user', async () => {
  clearBudgetStateCache()
  const { fetcher, counter } = makeFetcher()
  const env = makeEnv()

  await getUserBudgetState(env, 'near-limit', 'tok', fetcher, T0)
  await getUserBudgetState(env, 'healthy', 'tok', fetcher, T0)
  assert.equal(counter.firestoreReads, 2)

  shortenBudgetStateCacheTtl('near-limit', T0)

  await getUserBudgetState(env, 'near-limit', 'tok', fetcher, T0 + 20_000)
  await getUserBudgetState(env, 'healthy', 'tok', fetcher, T0 + 20_000)
  // Só o near-limit releu; o saudável continua na cache de 60s.
  assert.equal(counter.firestoreReads, 3)
})
