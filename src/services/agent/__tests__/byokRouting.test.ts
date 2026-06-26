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
  it('uses high reasoning effort for Step 3.7 Flash', () => {
    expect(buildByokThinkingConfig({
      providerId: 'stepfun',
      modelId: 'step-3.7-flash',
      baseURL: 'https://api.stepfun.ai/v1',
      custom: false,
      supportsThinking: true,
      thinkingShape: 'openai_reasoning_effort',
    })).toEqual({ reasoning_effort: 'high' })
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
})
