import assert from 'node:assert/strict'
import test from 'node:test'
import { applySessionAffinity, isCloudflareAI, SESSION_AFFINITY_HEADER } from '../src/providers'

/**
 * Afinidade de sessão do Workers AI (2026-08-10).
 *
 * Medido na sessão GLM-5.2/Cloudflare: 25,2% de cache-read com o prefixo
 * comprovadamente IDÊNTICO nos 35 pedidos (um só promptPrefixHash, prefixo de
 * mensagens nunca reescrito). Hits de 93-100% ou zero, sem correlação com o
 * tempo — sintoma de aterrar ora numa instância quente, ora numa fria.
 *
 * Doc: "prefix caching only works when a request routes to the same model
 * instance that holds the cached tensors" → header `x-session-affinity`.
 */

const CF = {
  provider: 'cloudflare',
  baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1',
  model: '@cf/zai-org/glm-5.2',
}
const DASHSCOPE = { provider: 'dashscope', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' }
const ZAI = { provider: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.2' }

test('injecta o header no Cloudflare', () => {
  const h = new Headers()
  const v = applySessionAffinity(h, CF, 'uid-123')
  assert.ok(v)
  assert.equal(h.get(SESSION_AFFINITY_HEADER), v)
})

test('o valor é ESTÁVEL para o mesmo utilizador — é disso que depende o cache', () => {
  const a = new Headers(); applySessionAffinity(a, CF, 'uid-123')
  const b = new Headers(); applySessionAffinity(b, CF, 'uid-123')
  assert.equal(a.get(SESSION_AFFINITY_HEADER), b.get(SESSION_AFFINITY_HEADER))
})

test('utilizadores diferentes não partilham instância', () => {
  const a = new Headers(); applySessionAffinity(a, CF, 'uid-123')
  const b = new Headers(); applySessionAffinity(b, CF, 'uid-456')
  assert.notEqual(a.get(SESSION_AFFINITY_HEADER), b.get(SESSION_AFFINITY_HEADER))
})

test('não manda o uid em claro', () => {
  const h = new Headers()
  applySessionAffinity(h, CF, 'YnEKtJuqscZA9ibOS0pTmxPI2Pp2')
  assert.ok(!h.get(SESSION_AFFINITY_HEADER)!.includes('YnEKtJuqscZA9ibOS0pTmxPI2Pp2'))
})

test('NÃO toca em provedores que não são Cloudflare', () => {
  for (const ctx of [DASHSCOPE, ZAI]) {
    const h = new Headers()
    assert.equal(applySessionAffinity(h, ctx, 'uid-123'), null)
    assert.equal(h.get(SESSION_AFFINITY_HEADER), null)
  }
})

test('sem uid não inventa afinidade', () => {
  const h = new Headers()
  assert.equal(applySessionAffinity(h, CF, null), null)
  assert.equal(applySessionAffinity(h, CF, '  '), null)
  assert.equal(h.get(SESSION_AFFINITY_HEADER), null)
})

test('o header do cliente não manda — set, não append', () => {
  const h = new Headers({ [SESSION_AFFINITY_HEADER]: 'forjado-pelo-cliente' })
  const v = applySessionAffinity(h, CF, 'uid-123')
  assert.equal(h.get(SESSION_AFFINITY_HEADER), v)
  assert.notEqual(h.get(SESSION_AFFINITY_HEADER), 'forjado-pelo-cliente')
})

test('isCloudflareAI detecta por provider/host, nunca pelo nome do modelo', () => {
  assert.equal(isCloudflareAI(CF), true)
  assert.equal(isCloudflareAI({ provider: 'workers-ai', baseUrl: '', model: '' }), true)
  assert.equal(isCloudflareAI({ provider: '', baseUrl: '', model: '@cf/meta/llama-4' }), true)
  // `zai-org` no id NÃO faz do z.AI um Cloudflare, nem o contrário.
  assert.equal(isCloudflareAI(ZAI), false)
  assert.equal(isCloudflareAI(DASHSCOPE), false)
})

/**
 * Afinidade por SESSÃO (2026-08-11).
 *
 * A chave por utilizador degradava com o número de runs — todos partilhavam a
 * mesma instância e despejavam o prefixo uns dos outros:
 *   1 run → 54,6%   5 runs → 36,2%   9 runs → 33,6%
 * (prefixo byte-estável em todas — um só promptPrefixHash por sessão.)
 */
test('a sessão manda sobre o uid', () => {
  const a = new Headers(); applySessionAffinity(a, CF, 'uid-1', 'sess-A')
  const b = new Headers(); applySessionAffinity(b, CF, 'uid-1', 'sess-B')
  assert.notEqual(a.get(SESSION_AFFINITY_HEADER), b.get(SESSION_AFFINITY_HEADER))
})

test('a mesma sessão é estável entre pedidos — é disso que o cache vive', () => {
  const a = new Headers(); applySessionAffinity(a, CF, 'uid-1', 'sess-A')
  const b = new Headers(); applySessionAffinity(b, CF, 'uid-1', 'sess-A')
  assert.equal(a.get(SESSION_AFFINITY_HEADER), b.get(SESSION_AFFINITY_HEADER))
})

test('sem sessão cai no uid — builds antigas não perdem a afinidade que tinham', () => {
  const semSessao = new Headers(); const v1 = applySessionAffinity(semSessao, CF, 'uid-1')
  const vazia = new Headers(); const v2 = applySessionAffinity(vazia, CF, 'uid-1', '  ')
  assert.ok(v1)
  assert.equal(v1, v2)
})

test('sem sessão E sem uid não inventa afinidade', () => {
  const h = new Headers()
  assert.equal(applySessionAffinity(h, CF, null, null), null)
  assert.equal(h.get(SESSION_AFFINITY_HEADER), null)
})

test('não manda o id da sessão em claro', () => {
  const h = new Headers()
  applySessionAffinity(h, CF, 'uid-1', 'session-1786-abcdef')
  assert.ok(!h.get(SESSION_AFFINITY_HEADER)!.includes('session-1786-abcdef'))
})
