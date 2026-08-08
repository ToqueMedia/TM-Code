/**
 * Os defaults do worker TÊM de bater com o mapa do frontend.
 *
 * O frontend (`src/services/agent/reasoningEffortModels.ts`) é a fonte de
 * verdade: os valores foram probados ao vivo contra z.AI e DashScope em
 * 2026-07-23. O worker precisa de os duplicar porque tem de decidir sozinho
 * quando o cliente não manda o header — mas duplicar sem guarda é garantir que
 * divergem.
 *
 * O perigo concreto não é teórico: o Grok aceita `low|medium|high` e um default
 * global de `max` mandava-lhe um valor fora do conjunto. Este teste lê o mapa
 * REAL do frontend em vez de repetir a lista aqui.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { applyReasoningEffort, defaultEffortFor } from '../src/applyReasoningEffort'

const FRONTEND_MAP = path.join(
  __dirname, '..', '..', '..', 'src', 'services', 'agent', 'reasoningEffortModels.ts',
)

/** `{ 'glm-5.2': { options: [...], default: 'max' }, … }` lido da fonte. */
function frontendEfforts(): Record<string, { options: string[]; default: string }> {
  const src = fs.readFileSync(FRONTEND_MAP, 'utf8')
  const block = src.slice(src.indexOf('EFFORT_BY_MODEL'), src.indexOf('GLM_LEGACY_EFFORT_ALIAS'))
  const out: Record<string, { options: string[]; default: string }> = {}
  const re = /'([a-z0-9.\-]+)':\s*\{[^}]*?options:\s*\[([^\]]*)\][^}]*?default:\s*'([a-z]+)'/g
  for (const m of block.matchAll(re)) {
    out[m[1]] = {
      options: [...m[2].matchAll(/'([a-z]+)'/g)].map(o => o[1]),
      default: m[3],
    }
  }
  return out
}

/** Contexto do worker para cada modelo do mapa. */
const CTX: Record<string, { provider: string; baseUrl: string; model: string }> = {
  'glm-5.2': { provider: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.2' },
  'grok-4.5': { provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.5' },
  'kimi-k3': { provider: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3' },
  'qwen3.8-max': { provider: 'dashscope', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' },
  // MiMo saiu do catálogo gerido a 2026-08-07; entrou o qwen3.7-plus.
  'qwen3.7-plus': { provider: 'dashscope', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' },
}

test('o parse do mapa do frontend não sai vazio', () => {
  const map = frontendEfforts()
  // Sem esta sanidade, um parse partido faria os testes abaixo passar por vácuo.
  assert.ok(Object.keys(map).length >= 3, `esperava >=3 modelos, li ${Object.keys(map).length}`)
})

test('o default do worker é o default do frontend, modelo a modelo', () => {
  for (const [model, spec] of Object.entries(frontendEfforts())) {
    const ctx = CTX[model]
    if (!ctx) continue
    assert.equal(defaultEffortFor(ctx), spec.default, `default divergente em ${model}`)
  }
})

test('o default está SEMPRE dentro dos valores válidos do modelo', () => {
  // A regressão que isto apanha: default global de `max` com o Grok a aceitar
  // só low|medium|high.
  for (const [model, spec] of Object.entries(frontendEfforts())) {
    const ctx = CTX[model]
    if (!ctx) continue
    assert.ok(
      spec.options.includes(defaultEffortFor(ctx)),
      `${model}: default "${defaultEffortFor(ctx)}" fora de [${spec.options}]`,
    )
  }
})

test('Grok sem header: default high, NUNCA max', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, '', CTX['grok-4.5'])
  assert.equal(body.reasoning_effort, 'high')
})

test('z.AI GLM sem header: max e thinking ligado', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, '', CTX['glm-5.2'])
  assert.equal(body.reasoning_effort, 'max')
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
})

test('DashScope GLM sem header: max e enable_thinking true', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, '', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'glm-5.2',
  })
  assert.equal(body.reasoning_effort, 'max')
  assert.equal(body.enable_thinking, true)
})

test('Kimi K3 sem header: max, e sem campos thinking', () => {
  const body: Record<string, unknown> = { thinking: { type: 'enabled' }, enable_thinking: true }
  applyReasoningEffort(body, '', CTX['kimi-k3'])
  assert.equal(body.reasoning_effort, 'max')
  assert.equal(body.thinking, undefined)
  assert.equal(body.enable_thinking, undefined)
})

test('provider desconhecido sem header continua no-op', () => {
  // Não inventamos um valor para uma API cujo conjunto válido não conhecemos.
  const body: Record<string, unknown> = { model: 'mimo-v2.5' }
  applyReasoningEffort(body, '', {
    provider: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
  })
  assert.equal(body.reasoning_effort, undefined)
})

test('header explícito continua a ganhar ao default', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'none', CTX['glm-5.2'])
  assert.equal(body.reasoning_effort, 'none')
  assert.deepEqual(body.thinking, { type: 'disabled' })
})
