/**
 * Phase 2 free/paid boundary — isFreePlan decides who pays for auxiliary model
 * calls under BYOK: free → user's key, paid → TM infra. Locking it down so the
 * policy can't silently drift (a wrong classification = wrong carrier billed).
 */
import 'openai/shims/node'
import { isFreePlan } from '../byokPlans'
import { buildByokThinkingConfig } from '../byokRouting'

describe('isFreePlan', () => {
  it('classifies paid plans (TM infra for auxiliaries)', () => {
    expect(isFreePlan('vibe')).toBe(false)
    expect(isFreePlan('pro')).toBe(false)
    expect(isFreePlan('max')).toBe(false)
  })

  it('classifies free / no-budget plans (self-funded under BYOK)', () => {
    expect(isFreePlan('explorer')).toBe(true)
    expect(isFreePlan('welcome')).toBe(true)
    expect(isFreePlan('byok-only')).toBe(true)
    // Unknown/未来 plans default to free (fail-safe: never bill TM infra for an
    // unrecognised plan under BYOK).
    expect(isFreePlan('something-new')).toBe(true)
  })
})

describe('buildByokThinkingConfig', () => {
  it('uses adaptive thinking with effort for Claude Opus 4.8', () => {
    expect(buildByokThinkingConfig({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      baseURL: 'https://api.anthropic.com',
      custom: false,
      supportsThinking: true,
      thinkingShape: 'anthropic',
      reasoningEffort: 'xhigh',
    })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    })
  })

  it('keeps manual thinking budget for older Anthropic models', () => {
    expect(buildByokThinkingConfig({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      baseURL: 'https://api.anthropic.com',
      custom: false,
      supportsThinking: true,
      thinkingShape: 'anthropic',
    })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8192 },
    })
  })

  it('keeps the existing medium default for other OpenAI-compatible reasoning models', () => {
    expect(buildByokThinkingConfig({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      baseURL: 'https://api.openai.com/v1',
      custom: false,
      supportsThinking: true,
      thinkingShape: 'openai_reasoning_effort',
    })).toEqual({ reasoning_effort: 'medium' })
  })

  it('maps xhigh/max to high for OpenAI-compatible reasoning providers', () => {
    expect(buildByokThinkingConfig({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      baseURL: 'https://api.openai.com/v1',
      custom: false,
      supportsThinking: true,
      thinkingShape: 'openai_reasoning_effort',
      reasoningEffort: 'max',
    })).toEqual({ reasoning_effort: 'high' })
  })

  it('emits reasoning.effort for OpenRouter (effort era silenciosamente ignorado)', () => {
    expect(buildByokThinkingConfig({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4-6',
      baseURL: 'https://openrouter.ai/api/v1',
      custom: false,
      supportsThinking: true,
      reasoningEffort: 'low',
    })).toEqual({ reasoning: { effort: 'low' } })
  })

  it('honra a shape declarada pelo user num host DESCONHECIDO (custom/self-hosted)', () => {
    // Sem detecção por baseURL, a declaração do catálogo do user é o único
    // sinal — com shape OpenAI-style o effort do Settings viaja no pedido.
    expect(buildByokThinkingConfig({
      providerId: 'my-gateway',
      modelId: 'my-model',
      baseURL: 'https://llm.internal.example.com/v1',
      custom: true,
      supportsThinking: true,
      thinkingShape: 'openai_reasoning_effort',
      reasoningEffort: 'high',
    })).toEqual({ reasoning_effort: 'high' })
  })

  it('host desconhecido SEM shape declarada não envia campo nenhum', () => {
    expect(buildByokThinkingConfig({
      providerId: 'my-gateway',
      modelId: 'my-model',
      baseURL: 'https://llm.internal.example.com/v1',
      custom: true,
      supportsThinking: true,
      reasoningEffort: 'high',
    })).toBeUndefined()
  })

  it('MiMo/Moonshot em thinking-ON não emitem nada (defaults nativos corretos)', () => {
    expect(buildByokThinkingConfig({
      providerId: 'xiaomi',
      modelId: 'mimo-v2.5-pro',
      baseURL: 'https://api.xiaomimimo.com/v1',
      custom: false,
      supportsThinking: true,
    })).toBeUndefined()
    expect(buildByokThinkingConfig({
      providerId: 'moonshot',
      modelId: 'kimi-k2.6',
      baseURL: 'https://api.moonshot.ai/v1',
      custom: false,
      supportsThinking: true,
    })).toBeUndefined()
  })
})
