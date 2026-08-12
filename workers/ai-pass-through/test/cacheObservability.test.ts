import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { buildCacheEvent } from '../src/logging'

/**
 * Observabilidade do cache (2026-08-12).
 *
 * O defeito que estes testes travam não é de cálculo — é de AUSÊNCIA. O worker
 * só escrevia quando `cachedTokens > 0`, portanto o log dava o numerador e
 * escondia o denominador: 11 misses em 17 pedidos apareciam como 6 linhas de
 * sucesso. A taxa de acerto do Cloudflare (35%, margem −55%) não é
 * confirmável enquanto os misses forem invisíveis.
 *
 * Mesma família do achado "telemetria que só dá zero" da auditoria de 07-29.
 */

const BASE = {
  requestId: 'req-1',
  provider: 'cloudflare',
  model: '@cf/zai-org/glm-5.2',
  affinity: 'tm_9cb242ad',
  authoritative: true,
}

test('um MISS produz evento — é o denominador que faltava', () => {
  const e = buildCacheEvent({ ...BASE, promptTokens: 50_000, cachedTokens: 0 })
  assert.equal(e.event, 'ai_cache')
  assert.equal(e.hit, false)
  assert.equal(e.cached_tokens, 0)
  assert.equal(e.cached_pct, 0)
  // O pedido conta para a amostra mesmo sem cache nenhum.
  assert.equal(e.prompt_tokens, 50_000)
})

test('um HIT produz a percentagem real do prefixo', () => {
  const e = buildCacheEvent({ ...BASE, promptTokens: 50_000, cachedTokens: 47_500 })
  assert.equal(e.hit, true)
  assert.equal(e.cached_pct, 95)
})

test('a afinidade viaja no evento — a pergunta é se a MESMA chave repete instância', () => {
  const e = buildCacheEvent({ ...BASE, promptTokens: 10, cachedTokens: 0 })
  assert.equal(e.affinity, 'tm_9cb242ad')
})

test('provider sem afinidade regista null, não omite o campo', () => {
  // Omitir tornava impossível distinguir "não tem mecanismo" de "falhou".
  const e = buildCacheEvent({ ...BASE, affinity: null, promptTokens: 10, cachedTokens: 10 })
  assert.equal(e.affinity, null)
  assert.ok('affinity' in e)
})

test('usage ESTIMADO é marcado — senão entra na amostra como miss', () => {
  // Um provider que omita o objecto `usage` dá cachedTokens=0 por construção.
  // Sem a flag, esses pedidos afundam a taxa medida sem nada os denunciar.
  const e = buildCacheEvent({ ...BASE, promptTokens: 1_000, cachedTokens: 0, authoritative: false })
  assert.equal(e.authoritative, false)
  assert.equal(e.hit, false)
})

test('prompt_tokens=0 não rebenta a divisão', () => {
  const e = buildCacheEvent({ ...BASE, promptTokens: 0, cachedTokens: 0 })
  assert.equal(e.cached_pct, 0)
})

/**
 * Asserção de SOURCE, no estilo dos portões do deadGateRewiring.test.ts do IDE.
 *
 * A forma do evento está coberta acima, mas nada disso impede alguém de voltar
 * a embrulhar a emissão num `if (usage.cachedTokens > 0)` para "reduzir ruído"
 * — que foi exactamente como o defeito nasceu. O que tem de ser inviolável é a
 * emissão ser INCONDICIONAL, e isso só se afirma sobre o ficheiro.
 */
test('o evento é emitido ANTES (e fora) do guard de cachedTokens > 0', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const emit = src.indexOf('buildCacheEvent({')
  const guard = src.indexOf('if (usage.cachedTokens > 0)')
  assert.ok(emit > 0, 'buildCacheEvent não é chamado no index.ts')
  assert.ok(guard > 0, 'o guard mudou de forma — reconfirmar este teste à mão')
  assert.ok(
    emit < guard,
    'a emissão do ai_cache caiu para dentro/depois do guard de cachedTokens>0: ' +
    'os misses voltam a ser invisíveis e a taxa de acerto deixa de ser mensurável',
  )
})

export {}
