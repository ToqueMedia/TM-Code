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
})
