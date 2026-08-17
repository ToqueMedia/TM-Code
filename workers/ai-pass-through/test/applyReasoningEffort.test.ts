import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReasoningEffort } from '../src/applyReasoningEffort'

test('catalog thinking on an unknown model applies reasoning_effort default', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, '', {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    thinking: { param: 'reasoning_effort', options: ['low', 'medium', 'high'], default: 'high' },
  })
  assert.equal(body.reasoning_effort, 'high')
})

test('catalog thinking rejects an effort outside options and falls back to default', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    thinking: { param: 'reasoning_effort', options: ['low', 'medium', 'high'], default: 'high' },
  })
  assert.equal(body.reasoning_effort, 'high')
})

test('catalog enable_thinking on an unknown model does not send reasoning_effort', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'off', {
    provider: 'acme',
    baseUrl: 'https://provider.test/v1',
    model: 'acme-hybrid-1',
    thinking: { param: 'enable_thinking', options: ['off', 'on'], default: 'on' },
  })
  assert.equal(body.enable_thinking, false)
  assert.equal(body.reasoning_effort, undefined)
})

test('catalog thinking_object on an unknown model writes thinking.type', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'on', {
    provider: 'acme',
    baseUrl: 'https://provider.test/v1',
    model: 'acme-think-1',
    thinking: { param: 'thinking_object', options: ['off', 'on'], default: 'on' },
  })
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, undefined)
})

test('writes reasoning_effort for any provider', () => {
  // Provider genuinamente desconhecido (o MiMo deixou de servir de arquétipo
  // aqui — desde 2026-08-05 tem regras próprias: thinking_object, sem effort).
  const body: Record<string, unknown> = { model: 'x' }
  applyReasoningEffort(body, 'high', {
    provider: 'acme',
    baseUrl: 'https://provider.test/v1',
    model: 'acme-coder-1',
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
  // `clear_thinking: false` juntou-se em 2026-08 (Preserved Thinking) — ver
  // preservedThinking.test.ts para o porquê e para o caso do DashScope.
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
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

// MiMo hospedado (2026-08-05): thinking_object on/off, SEM reasoning_effort.
// Default OFF por recomendação oficial da Xiaomi para tool calling (FAQ:
// thinking ligado torna tool_calls instáveis) — todo o tráfego TM é agentic.
test('MiMo: default é thinking disabled e nunca envia reasoning_effort', () => {
  const body: Record<string, unknown> = { enable_thinking: true }
  applyReasoningEffort(body, '', {
    provider: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
  })
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal('reasoning_effort' in body, false)
  assert.equal('enable_thinking' in body, false)
})

test('MiMo: effort "on" liga thinking:{type:enabled}', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'on', {
    provider: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
  })
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal('reasoning_effort' in body, false)
})

// Qwen 3.7 como modelo PRINCIPAL (2026-08-07). Híbrido por boolean: o toggle
// vira `enable_thinking` e `reasoning_effort` é apagado — a escala graded é do
// 3.8-max e esta família não a documenta.
test('Qwen 3.7 Plus: default liga enable_thinking e NÃO envia reasoning_effort', () => {
  const body: Record<string, unknown> = { reasoning_effort: 'max' }
  applyReasoningEffort(body, '', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-plus',
  })
  assert.equal(body.enable_thinking, true)
  assert.equal('reasoning_effort' in body, false)
  // preserve_thinking: documentado para qwen3.7-*; faz par com o round-trip de
  // reasoning_content da IDE (sem ele o servidor descarta o que já pagámos).
  assert.equal(body.preserve_thinking, true)
})

test('Qwen 3.7 Plus: effort "off" desliga o thinking e o preserve_thinking', () => {
  const body: Record<string, unknown> = { preserve_thinking: true }
  applyReasoningEffort(body, 'off', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-plus',
  })
  assert.equal(body.enable_thinking, false)
  assert.equal('reasoning_effort' in body, false)
  assert.equal('preserve_thinking' in body, false)
})

// A regressão que este teste tranca: o sidecar:utility É um qwen3.7-flash com
// enable_thinking:false publicado de propósito. Um pedido auxiliar que leve o
// header de effort do modelo PRINCIPAL ('max' do GLM) não pode ligar-lhe o
// thinking — valor fora das options desta família é ignorado.
test('Qwen 3.7 Flash (sidecar utility): effort de OUTRA escala não toca no body', () => {
  const body: Record<string, unknown> = { enable_thinking: false }
  applyReasoningEffort(body, 'max', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-flash',
  })
  assert.equal(body.enable_thinking, false)
  assert.equal('reasoning_effort' in body, false)
  assert.equal('preserve_thinking' in body, false)
})

// O GLM na MESMA DashScope continua no seu ramo: reasoning_effort mantém-se e
// preserve_thinking NÃO entra (a doc não o lista para o GLM).
test('GLM na DashScope não é apanhado pelo ramo do Qwen 3.7', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', {
    provider: 'dashscope',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    model: 'glm-5.2',
  })
  assert.equal(body.reasoning_effort, 'max')
  assert.equal(body.enable_thinking, true)
  assert.equal('preserve_thinking' in body, false)
})

// Cloudflare AI Gateway (swap 2026-08-04): provider 'cloudflare' + model em
// sintaxe author/model. As regras por-modelo TÊM de continuar a disparar —
// era exatamente o buraco do startsWith() sem bareModel.
test('Grok 4.5 via Cloudflare gateway (xai/grok-4.5) keeps the xAI rules', () => {
  const body: Record<string, unknown> = { thinking: { type: 'enabled' } }
  applyReasoningEffort(body, '', {
    provider: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1',
    model: 'xai/grok-4.5',
  })
  // default 'high' aplicado + companions limpos
  assert.equal(body.reasoning_effort, 'high')
  assert.equal('thinking' in body, false)
})

test('Kimi K3 via Cloudflare gateway (moonshotai/kimi-k3) keeps the K3 rules', () => {
  const body: Record<string, unknown> = {
    enable_thinking: true,
    temperature: 0.7,
  }
  applyReasoningEffort(body, '', {
    provider: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1',
    model: 'moonshotai/kimi-k3',
  })
  // default 'max' aplicado, thinking limpo, temperature≠1 removida
  assert.equal(body.reasoning_effort, 'max')
  assert.equal('enable_thinking' in body, false)
  assert.equal('temperature' in body, false)
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
  // (O MiMo saiu deste fixture — agora tem default 'off' por doc da Xiaomi.)
  const body: Record<string, unknown> = { foo: 1 }
  applyReasoningEffort(body, '  ', {
    provider: 'acme',
    baseUrl: 'https://provider.test/v1',
    model: 'acme-coder-1',
  })
  assert.deepEqual(body, { foo: 1 })
})
