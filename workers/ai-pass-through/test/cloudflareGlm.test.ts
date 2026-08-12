import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReasoningEffort, defaultEffortFor } from '../src/applyReasoningEffort'

/**
 * GLM-5.2 no Cloudflare Workers AI — TERCEIRO provedor do mesmo modelo
 * (2026-08-10). Doc: developers.cloudflare.com/workers-ai/models/glm-5.2/
 *   · id `@cf/zai-org/glm-5.2`, janela 262 144
 *   · reasoning via `reasoning_effort` (descrição da OpenAI → low|medium|high)
 *
 * O risco desta configuração é mandar ao Cloudflare os parâmetros do z.AI
 * (`thinking:{type, clear_thinking}`) ou do DashScope (`enable_thinking`).
 * O id contém `zai-org`, que é exactamente a coincidência capaz de enganar um
 * detector por NOME — daí a detecção ser por provider/host.
 */

const CF = {
  provider: 'cloudflare',
  baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1',
  model: '@cf/zai-org/glm-5.2',
}
const ZAI = { provider: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.2' }
const DASHSCOPE = { provider: 'dashscope', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', model: 'glm-5.2' }

test('GLM no Cloudflare leva reasoning_effort e MAIS NADA', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'high', CF)
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.thinking, undefined, 'thinking é do z.AI, não do Cloudflare')
  assert.equal(body.enable_thinking, undefined, 'enable_thinking é do DashScope')
})

test('o id @cf/zai-org/... NÃO é confundido com o z.AI', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'high', CF)
  assert.equal(body.thinking, undefined)
})

test('default do Cloudflare é high (conjunto OpenAI), não max', () => {
  assert.equal(defaultEffortFor(CF), 'high')
  assert.equal(defaultEffortFor(ZAI), 'max')
  assert.equal(defaultEffortFor(DASHSCOPE), 'max')
})

test('os outros dois provedores do MESMO modelo não mudam', () => {
  const zai: Record<string, unknown> = {}
  applyReasoningEffort(zai, 'max', ZAI)
  assert.deepEqual(zai.thinking, { type: 'enabled', clear_thinking: false })

  const ds: Record<string, unknown> = {}
  applyReasoningEffort(ds, 'max', DASHSCOPE)
  assert.equal(ds.enable_thinking, true)
})

test('effort off no Cloudflare não inventa desligamento por parâmetro do z.AI', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'off', CF)
  assert.equal(body.thinking, undefined)
  assert.equal(body.enable_thinking, undefined)
})
