/**
 * Metering 30/70 (2026-08-11): o consumo deixou de ser "tokens faturáveis
 * com factor de cache" e passou a ser o CUSTO REAL do provider em µ$.
 * Estes são os testes do motor de pricing que substituiu o antigo
 * billableTokenTotal/resolveCacheBillingFactor.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_PRICING,
  byokCacheRatio,
  computeRequestCostMicros,
  imageCostMicros,
  resolveModelPricing,
} from '../src/pricing'
import { explorerTokenTotal } from '../src/billing'

// ── Tabela de preços (fornecida pelo developer, 2026-08-11) ───────────────
// Guard contra typos na tabela: estes são os valores publicados. Se um preço
// mudar, muda AQUI e no comentário da decisão — não em silêncio.

test('a tabela tem os preços publicados (guard contra typos)', () => {
  const cases: Array<[string, string, [number, number, number]]> = [
    ['dashscope', 'glm-5.2', [1.10, 0.275, 3.851]],
    ['zai', 'glm-5.2', [1.40, 0.26, 4.40]],
    ['cloudflare', '@cf/zai-org/glm-5.2', [1.40, 0.26, 4.40]],
    ['dashscope', 'qwen3.8-max', [1.65, 0.206, 4.951]],
    ['dashscope', 'qwen3.7-plus', [0.276, 0.056, 1.101]],
    ['dashscope', 'qwen3.7-flash', [0.028, 0.006, 0.11]],
    ['xai', 'grok-4.5', [2.00, 0.30, 6.00]],
  ]
  for (const [provider, model, [input, cached, output]] of cases) {
    const r = resolveModelPricing({ provider, baseUrl: '', model })
    assert.equal(r.fallback, false, `${provider}:${model} caiu no fallback`)
    assert.equal(r.pricing.inputPerM, input, `input ${provider}:${model}`)
    assert.equal(r.pricing.cachedPerM, cached, `cached ${provider}:${model}`)
    assert.equal(r.pricing.outputPerM, output, `output ${provider}:${model}`)
  }
})

// ── Cálculo de custo ──────────────────────────────────────────────────────

test('custo = miss×input + hit×cache + output×output (em µ$)', () => {
  const pricing = resolveModelPricing({ provider: 'dashscope', model: 'glm-5.2' }).pricing
  // prompt 90229 (cached 89216) + completion 1018 — o exemplo real do log.
  const micros = computeRequestCostMicros(
    { promptTokens: 90_229, completionTokens: 1_018, cachedTokens: 89_216 },
    pricing,
  )
  // 1013×1.10 + 89216×0.275 + 1018×3.851 = 1114.3 + 24534.4 + 3920.318
  assert.equal(micros, Math.ceil(1013 * 1.10 + 89_216 * 0.275 + 1_018 * 3.851))
  assert.equal(micros, 29_570) // ≈ $0.02957 — o valor da demonstração
})

test('sem cache paga-se o prompt inteiro a preço de input', () => {
  const pricing = resolveModelPricing({ provider: 'dashscope', model: 'glm-5.2' }).pricing
  const micros = computeRequestCostMicros({ promptTokens: 1_000, completionTokens: 200, cachedTokens: 0 }, pricing)
  assert.equal(micros, Math.ceil(1_000 * 1.10 + 200 * 3.851))
})

test('o MESMO modelo custa diferente por provider (glm-5.2: DashScope vs z.AI)', () => {
  const usage = { promptTokens: 100_000, completionTokens: 1_000, cachedTokens: 95_000 }
  const ds = computeRequestCostMicros(usage, resolveModelPricing({ provider: 'dashscope', model: 'glm-5.2' }).pricing)
  const zai = computeRequestCostMicros(usage, resolveModelPricing({ provider: 'zai', model: 'glm-5.2' }).pricing)
  assert.notEqual(ds, zai)
  // z.AI é mais caro em toda a linha para este mix.
  assert.ok(zai > ds, `z.AI ${zai} devia ser > DashScope ${ds}`)
})

test('cached clampado a promptTokens (nunca custa negativo)', () => {
  const pricing = resolveModelPricing({ provider: 'dashscope', model: 'glm-5.2' }).pricing
  // cached > prompt (defeito de provider) não pode criar "crédito".
  const micros = computeRequestCostMicros({ promptTokens: 500, completionTokens: 50, cachedTokens: 9_999 }, pricing)
  assert.equal(micros, Math.ceil(500 * 0.275 + 50 * 3.851))
})

test('nunca arredonda para baixo (ceil — a margem não paga o arredondamento)', () => {
  const pricing = { inputPerM: 1, cachedPerM: 0.5, outputPerM: 2 }
  const micros = computeRequestCostMicros({ promptTokens: 1, completionTokens: 0, cachedTokens: 1 }, pricing)
  assert.equal(micros, 1) // 1×0.5 = 0.5 µ$ → ceil 1, nunca 0
})

// ── Resolução de família/id ───────────────────────────────────────────────

test('Workers AI: o prefixo @cf/author/ não muda o preço do modelo nu', () => {
  const cf = resolveModelPricing({ provider: 'cloudflare', baseUrl: 'https://api.cloudflare.com', model: '@cf/zai-org/glm-5.2' })
  const direto = resolveModelPricing({ provider: 'cloudflare', model: 'glm-5.2' })
  assert.deepEqual(cf.pricing, direto.pricing)
})

test('gateway author/model: xai/grok-4.5 resolve para o preço x.AI', () => {
  const r = resolveModelPricing({ provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'xai/grok-4.5' })
  assert.equal(r.fallback, false)
  assert.equal(r.pricing.inputPerM, 2.0)
})

test('host também identifica a família (baseUrl sem provider explícito)', () => {
  const r = resolveModelPricing({ baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode', model: 'glm-5.2' })
  assert.equal(r.fallback, false)
  assert.equal(r.pricing.inputPerM, 1.10)
})

test('modelo desconhecido → fallback conservador + sinalizado (nunca custo zero)', () => {
  const r = resolveModelPricing({ provider: 'novo-provider', model: 'modelo-misterioso' })
  assert.equal(r.fallback, true)
  assert.deepEqual(r.pricing, FALLBACK_PRICING)
  const micros = computeRequestCostMicros({ promptTokens: 1_000, completionTokens: 0, cachedTokens: 0 }, r.pricing)
  assert.ok(micros > 0)
})

// ── Imagens (custo por imagem, em µ$) ─────────────────────────────────────

test('imageCostMicros converte USD → µ$ com ceil', () => {
  assert.equal(imageCostMicros(0.04), 40_000)    // 1 imagem 1K
  assert.equal(imageCostMicros(0.075), 75_000)   // 1 imagem 2K
  assert.equal(imageCostMicros(0.003), 3_000)    // 1 imagem de referência
  assert.equal(imageCostMicros(0), 0)
  assert.equal(imageCostMicros(-1), 0)
})

// ── Ledger Team BYOK (tokens, com desconto de cache REAL) ─────────────────

test('byokCacheRatio: proporção real do provider; sem pricing → 1 (raw)', () => {
  const ds = resolveModelPricing({ provider: 'dashscope', model: 'glm-5.2' }).pricing
  assert.ok(Math.abs(byokCacheRatio(ds) - 0.275 / 1.10) < 1e-9)
  assert.equal(byokCacheRatio(null), 1)
})

// ── Explorer (único plano em tokens) ──────────────────────────────────────

test('explorer conta tokens reais: prompt + completion, sem desconto', () => {
  assert.equal(explorerTokenTotal({ promptTokens: 1_000, completionTokens: 200 }), 1_200)
  assert.equal(explorerTokenTotal({ promptTokens: -5, completionTokens: 10 }), 10)
})
