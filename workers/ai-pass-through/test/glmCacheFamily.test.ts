import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDashScopePromptCache, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/dashscopePromptCache'

/**
 * O gate do cache explícito não pode estar preso a um número de versão.
 *
 * Era `model !== 'glm-5.1'`. Trocar o modelo gerido é uma edição de DADOS no
 * KV — foi assim que o activo passou a `glm-5.2` e esta igualdade deixou de
 * bater, sem um erro, sem um log. Sem marcadores de cache o prefixo congela no
 * bloco estático e todo o histórico é refacturado a cada turno: a sessão
 * katondo-queue (29-07) fechou com 12,36M tokens de input, 36% de cache e o
 * valor cacheado parado em 31.808 desde o turno 11.
 */

/** Bloco estático grande o suficiente para passar EXPLICIT_CACHE_MIN_STATIC_BYTES. */
const STATIC = 'x'.repeat(8192)

function bodyWithSystem(): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: `${STATIC}${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}parte volátil` },
      { role: 'user', content: 'olá' },
    ],
  }
}

const DASHSCOPE = { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }

test('glm-5.2 recebe marcadores de cache — era o caso que falhava', () => {
  const stats = applyDashScopePromptCache(bodyWithSystem(), { ...DASHSCOPE, model: 'glm-5.2' })
  assert.equal(stats.cacheControlApplied, true)
})

test('glm-5.1 continua a receber — nenhuma regressão no que já funcionava', () => {
  const stats = applyDashScopePromptCache(bodyWithSystem(), { ...DASHSCOPE, model: 'glm-5.1' })
  assert.equal(stats.cacheControlApplied, true)
})

test('qualquer ponto de versão futuro da família passa sem novo commit', () => {
  for (const model of ['glm-5.3', 'glm-6', 'GLM-5.2-preview']) {
    const stats = applyDashScopePromptCache(bodyWithSystem(), { ...DASHSCOPE, model })
    assert.equal(stats.cacheControlApplied, true, `${model} devia cachear`)
  }
})

test('modelo fora da família e fora da lista NÃO é marcado', () => {
  const stats = applyDashScopePromptCache(bodyWithSystem(), { ...DASHSCOPE, model: 'modelo-desconhecido' })
  assert.equal(stats.cacheControlApplied, false)
})

test('o gate de host mantém-se: glm fora do host suportado não é marcado', () => {
  const stats = applyDashScopePromptCache(bodyWithSystem(), {
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'glm-5.2',
  })
  // Host suportado → marcado. O contraste é com um host não-DashScope, que
  // nem chega ao gate de modelo (isDashScopeProvider corta antes).
  assert.equal(stats.cacheControlApplied, true)

  const outro = applyDashScopePromptCache(bodyWithSystem(), {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'glm-5.2',
  })
  assert.equal(outro.cacheControlApplied, false)
})
