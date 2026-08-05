/**
 * Desconto de faturação de tokens cacheados (2026-07-15).
 * Tokens de prompt cacheados faturam a CACHE_BILLING_FACTOR (default 0.5);
 * não-cacheados a 100%. cached é subconjunto de promptTokens.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billableTokenTotal, resolveCacheBillingFactor } from '../src/billing'
import type { Env } from '../src/types'

const env = (overrides: Partial<Env> = {}) => overrides as Env

test('sem cache → fatura tudo a 100% (billable = prompt + completion)', () => {
  assert.equal(billableTokenTotal({ promptTokens: 1000, completionTokens: 200, cachedTokens: 0 }, 0.5), 1200)
})

test('cache a 50% → desconta metade dos tokens cacheados', () => {
  // prompt 10000 (dos quais 8000 cache) + completion 500.
  // billable = 10000 − floor(8000·0.5) + 500 = 10000 − 4000 + 500 = 6500.
  assert.equal(billableTokenTotal({ promptTokens: 10_000, completionTokens: 500, cachedTokens: 8_000 }, 0.5), 6_500)
})

test('loop agentico: prefixo quase todo em cache → poupança grande', () => {
  // 50000 prompt, 48000 em cache, 300 completion.
  // billable = 50000 − 24000 + 300 = 26300 (vs 50300 sem desconto).
  const full = 50_000 + 300
  const discounted = billableTokenTotal({ promptTokens: 50_000, completionTokens: 300, cachedTokens: 48_000 }, 0.5)
  assert.equal(discounted, 26_300)
  assert.ok(discounted < full)
})

test('factor 0 → cacheados grátis; factor 1 → sem desconto (100%)', () => {
  const u = { promptTokens: 1000, completionTokens: 100, cachedTokens: 1000 }
  assert.equal(billableTokenTotal(u, 0), 100)      // prompt todo cacheado, grátis
  assert.equal(billableTokenTotal(u, 1), 1100)     // sem desconto
})

test('cached clampado a promptTokens (nunca desconta mais do que o prompt)', () => {
  // cached reportado > prompt (defeito de provider) não pode inflar o desconto.
  assert.equal(billableTokenTotal({ promptTokens: 500, completionTokens: 50, cachedTokens: 9999 }, 0.5), 300)
})

test('resolveCacheBillingFactor: constante 0.5 — consumo NÃO é mutável por env (decisão 05-08)', () => {
  // O antigo env TM_CACHE_BILLING_FACTOR foi removido: o único knob de
  // consumo é o costMultiplier por persona, publicado pela UI do admin.
  assert.equal(resolveCacheBillingFactor({} as never), 0.5)
  assert.equal(resolveCacheBillingFactor({ TM_CACHE_BILLING_FACTOR: '0.9' } as never), 0.5)
})
