import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReasoningEffort } from '../src/applyReasoningEffort'

test('writes reasoning_effort for any provider', () => {
  const body: Record<string, unknown> = { model: 'x' }
  applyReasoningEffort(body, 'high', {
    provider: 'mimo',
    baseUrl: 'https://provider.test/v1',
    model: 'mimo-v2.5',
  })
  assert.equal(body.reasoning_effort, 'high')
})

test('DashScope GLM: effort=high forces enable_thinking true (overrides extraBody false)', () => {
  const body: Record<string, unknown> = { enable_thinking: false, model: 'glm-5.2' }
  applyReasoningEffort(body, 'high', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'glm-5.2',
  })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.enable_thinking, true)
})

test('DashScope GLM: effort=none sets enable_thinking false', () => {
  const body: Record<string, unknown> = { enable_thinking: true }
  applyReasoningEffort(body, 'none', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    model: 'glm-5.2',
  })
  assert.equal(body.reasoning_effort, 'none')
  assert.equal(body.enable_thinking, false)
})

test('DashScope GLM: effort=minimal also disables thinking', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'minimal', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'glm-5.2',
  })
  assert.equal(body.enable_thinking, false)
})

test('z.AI GLM: effort=max enables thinking object', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', {
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.2',
  })
  assert.equal(body.reasoning_effort, 'max')
  assert.deepEqual(body.thinking, { type: 'enabled' })
})

test('z.AI GLM: effort=none disables thinking object', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'none', {
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
  })
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('Kimi K3: strips thinking/enable_thinking from extraBody', () => {
  const body: Record<string, unknown> = {
    thinking: { type: 'enabled' },
    enable_thinking: true,
  }
  applyReasoningEffort(body, 'max', {
    provider: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
  })
  assert.equal(body.reasoning_effort, 'max')
  assert.equal('thinking' in body, false)
  assert.equal('enable_thinking' in body, false)
})

test('Kimi K3: strips temperature≠1 (API 400: only 1 allowed)', () => {
  const body: Record<string, unknown> = {
    temperature: 0.7,
    top_p: 0.9,
    frequency_penalty: 0.1,
  }
  applyReasoningEffort(body, 'low', {
    provider: 'moonshotai',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
  })
  assert.equal(body.reasoning_effort, 'low')
  assert.equal('temperature' in body, false)
  assert.equal('top_p' in body, false)
  assert.equal('frequency_penalty' in body, false)
})

test('Kimi K3: keeps temperature=1', () => {
  const body: Record<string, unknown> = { temperature: 1 }
  applyReasoningEffort(body, 'high', {
    provider: 'kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
  })
  assert.equal(body.temperature, 1)
  assert.equal(body.reasoning_effort, 'high')
})

test('provider moonshotai is detected as Moonshot family', () => {
  const body: Record<string, unknown> = { thinking: { type: 'enabled' } }
  applyReasoningEffort(body, 'low', {
    provider: 'moonshotai',
    baseUrl: 'https://example.com/v1',
    model: 'kimi-k3',
  })
  assert.equal('thinking' in body, false)
  assert.equal(body.reasoning_effort, 'low')
})

test('Grok 4.5: strips thinking companions', () => {
  const body: Record<string, unknown> = {
    thinking: { type: 'enabled' },
    enable_thinking: true,
  }
  applyReasoningEffort(body, 'high', {
    provider: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.5',
  })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal('thinking' in body, false)
  assert.equal('enable_thinking' in body, false)
})

// MUDANÇA DELIBERADA (2026-08): "effort vazio = no-op" deixou de valer para
// modelos com default conhecido. Motivo: até este worker ser deployado o header
// era ignorado, portanto há builds da IDE lá fora que não o enviam — e sem
// default ficavam sem `reasoning_effort` E sem os companions, à mercê do que o
// extraBody da KV tivesse. Ver defaultEffortFor + reasoningEffortDefaults.test.
test('empty effort on a model WITH a known default applies that default', () => {
  const body: Record<string, unknown> = { foo: 1 }
  applyReasoningEffort(body, '  ', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/v1',
    model: 'glm-5.2',
  })
  assert.deepEqual(body, { foo: 1, reasoning_effort: 'max', enable_thinking: true })
})

test('empty effort on an UNKNOWN provider is still a no-op', () => {
  // A intenção original do teste acima, preservada onde continua a valer: não
  // inventamos um valor para uma API cujo conjunto válido não conhecemos.
  const body: Record<string, unknown> = { foo: 1 }
  applyReasoningEffort(body, '  ', {
    provider: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
  })
  assert.deepEqual(body, { foo: 1 })
})
