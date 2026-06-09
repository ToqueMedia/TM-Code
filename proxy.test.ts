import { describe, it, expect } from 'vitest'
import {
  MODEL_TO_PROVIDER,
  MODEL_CONTEXT_BUDGET,
  MODEL_CATALOG,
  PROVIDERS,
  getCoderModels,
  canonicalModelId,
  computeUpstreamRetryDelayMs,
  resolveProviderModelId,
  resolveMemorySidecarModel,
  resolveModelAndProvider,
  parseRetryAfterMs,
} from '../proxy'
import type { PlanConfig } from '../types'

// The coder models the Admin Panel must be able to route correctly.
// Each row asserts the end-to-end resolution: what the admin selects
// (catalog id) → which provider config the worker picks → which model
// string the upstream API actually receives.

interface CoderCase {
  catalogId: string
  displayName: string
  providerLabel: string
  providerKey: string
  upstreamModelId: string
  /** Exact apiUrl to assert — omit for template-based URLs and use providerUrlContains instead. */
  providerUrl?: string
  /** Substring that must appear in the resolved apiUrl (for template-based providers like Vertex AI). */
  providerUrlContains?: string
}

const CODER_MODELS: CoderCase[] = [
  {
    catalogId: 'glm-5.1',
    displayName: 'GLM-5.1',
    providerLabel: 'Alibaba China',
    providerKey: 'dashscope',
    upstreamModelId: 'glm-5.1',
    providerUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  },
  {
    catalogId: 'qwen3.7-max',
    displayName: 'Qwen 3.7 Max',
    providerLabel: 'Alibaba China',
    providerKey: 'dashscope',
    upstreamModelId: 'qwen3.7-max',
    providerUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  },
  {
    catalogId: 'mimo-v2.5-pro-1m',
    displayName: 'MiMo V2.5 Pro \u00b7 1M',
    providerLabel: 'Official',
    providerKey: 'mimo-anthropic',
    upstreamModelId: 'mimo-v2.5-pro',
    providerUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
  },
  {
    catalogId: 'mimo-v2.5-1m',
    displayName: 'MiMo V2.5 \u00b7 1M',
    providerLabel: 'Official',
    providerKey: 'mimo-anthropic',
    upstreamModelId: 'mimo-v2.5',
    providerUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
  },
  {
    catalogId: 'step-3.7-flash',
    displayName: 'Step 3.7 Flash',
    providerLabel: 'StepFun',
    providerKey: 'stepfun',
    upstreamModelId: 'step-3.7-flash',
    providerUrl: 'https://api.stepfun.ai/v1/chat/completions',
  },
  {
    catalogId: 'minimax-m2.7',
    displayName: 'MiniMax M2.7',
    providerLabel: 'MiniMax',
    providerKey: 'minimax',
    upstreamModelId: 'MiniMax-M2.7',
    providerUrl: 'https://api.minimax.io/v1/chat/completions',
  },
  {
    catalogId: 'minimax-m3',
    displayName: 'MiniMax M3',
    providerLabel: 'MiniMax',
    providerKey: 'minimax',
    upstreamModelId: 'MiniMax-M3',
    providerUrl: 'https://api.minimax.io/v1/chat/completions',
  },
  {
    catalogId: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    providerLabel: 'Google',
    providerKey: 'gemini',
    upstreamModelId: 'google/gemini-3.5-flash',
    providerUrl: 'https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/endpoints/openapi/chat/completions',
  },
  {
    catalogId: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    providerLabel: 'Google',
    providerKey: 'gemini',
    upstreamModelId: 'google/gemini-3.1-pro-preview',
    providerUrl: 'https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/endpoints/openapi/chat/completions',
  },
]

describe('admin coder catalog — end-to-end model routing', () => {
  for (const m of CODER_MODELS) {
    describe(m.catalogId, () => {
      it('is listed in the coder catalog with expected display metadata', () => {
        const entry = MODEL_CATALOG.find(e => e.id === m.catalogId)
        expect(entry).toBeDefined()
        expect(entry?.name).toBe(m.displayName)
        expect(entry?.providerLabel).toBe(m.providerLabel)
        expect(entry?.category).toBe('coder')
      })

      it('resolves to the expected provider key', () => {
        expect(MODEL_TO_PROVIDER[m.catalogId]).toBe(m.providerKey)
      })

      it('has a context-window budget registered', () => {
        expect(MODEL_CONTEXT_BUDGET[m.catalogId]).toBeGreaterThan(0)
      })

      it('resolveProviderModelId returns the upstream model id', () => {
        expect(resolveProviderModelId(m.catalogId, m.providerKey)).toBe(m.upstreamModelId)
      })

      it('provider config exposes the expected upstream URL', () => {
        const cfg = PROVIDERS[m.providerKey]
        expect(cfg).toBeDefined()
        if (m.providerUrl) {
          expect(cfg.apiUrl).toBe(m.providerUrl)
        } else if (m.providerUrlContains) {
          expect(cfg.apiUrl).toContain(m.providerUrlContains)
        }
      })

      it('resolveModelAndProvider uses this model when set as the plan default', () => {
        const plan: PlanConfig = {
          planId: 'pro',
          model: m.catalogId,
          provider: m.providerKey,
          requestsPerMinute: 999_999,
          requestsPerDay: 999_999,
          tokenBudget: 10_000_000,
          planModel: 'glm-5.1',
          planModelProvider: 'dashscope',
          planFallbackModel: m.catalogId,
          byokAllowed: false,
        }
        const resolved = resolveModelAndProvider(plan, 'production')
        expect(resolved).not.toBeNull()
        expect(resolved?.model).toBe(m.catalogId)
        expect(resolved?.providerKey).toBe(m.providerKey)
      })
    })
  }
})

describe('upstream retry backoff', () => {
  it('parses Retry-After seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000)
  })

  it('respects Retry-After before exponential backoff', () => {
    expect(computeUpstreamRetryDelayMs(4, '7')).toBe(7000)
  })

  it('uses truncated exponential backoff with bounded jitter', () => {
    const delay1 = computeUpstreamRetryDelayMs(1)
    const delay2 = computeUpstreamRetryDelayMs(2)
    const delay5 = computeUpstreamRetryDelayMs(5)
    const delay8 = computeUpstreamRetryDelayMs(8)

    expect(delay1).toBeGreaterThanOrEqual(5000)
    expect(delay1).toBeLessThan(6000)
    expect(delay2).toBeGreaterThanOrEqual(10000)
    expect(delay2).toBeLessThan(11000)
    expect(delay5).toBeGreaterThanOrEqual(60000)
    expect(delay5).toBeLessThan(61000)
    expect(delay8).toBeGreaterThanOrEqual(60000)
    expect(delay8).toBeLessThan(61000)
  })
})

describe('getCoderModels', () => {
  it('returns exactly the admin-managed coder entries', () => {
    const ids = getCoderModels().map(m => m.id).sort()
    expect(ids).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash',
      'glm-5.1',
      'mimo-v2.5-1m',
      'mimo-v2.5-pro-1m',
      'minimax-m2.7',
      'minimax-m3',
      'qwen3.7-max',
      'step-3.7-flash',
    ])
  })

  it('excludes non-coder entries (e.g. reasoning, chat)', () => {
    for (const m of getCoderModels()) {
      expect(m.category).toBe('coder')
    }
  })
})

describe('canonicalModelId', () => {
  it('returns the model unchanged when no alias exists', () => {
    expect(canonicalModelId('glm-5.1')).toBe('glm-5.1')
    expect(canonicalModelId('mimo-v2.5-pro-1m')).toBe('mimo-v2.5-pro-1m')
  })
})

describe('resolveProviderModelId fallback', () => {
  it('returns the model unchanged when no upstream translation is registered', () => {
    expect(resolveProviderModelId('glm-5.1', 'dashscope')).toBe('glm-5.1')
    expect(resolveProviderModelId('qwen3.7-max', 'dashscope')).toBe('qwen3.7-max')
  })
})

describe('resolveMemorySidecarModel', () => {
  it('routes MiMo V2.5 Pro coder plans to the MiMo V2.5 memory sidecar', () => {
    const sidecar = resolveMemorySidecarModel('mimo-v2.5-pro-1m')
    expect(sidecar).toEqual({ model: 'mimo-v2.5-1m', provider: 'mimo-anthropic' })
    expect(resolveProviderModelId(sidecar.model, sidecar.provider)).toBe('mimo-v2.5')
  })

  it('keeps non-MiMo Pro coder plans on the default Qwen memory sidecar', () => {
    expect(resolveMemorySidecarModel('glm-5.1')).toEqual({ model: 'qwen3.6-plus', provider: 'dashscope' })
    expect(resolveMemorySidecarModel('deepseek-v4-flash')).toEqual({ model: 'qwen3.6-plus', provider: 'dashscope' })
  })
})

// Catalog integrity — prevents future regressions where someone adds a model
// to MODEL_CATALOG but forgets to wire the routing tables. Every admin-visible
// model MUST have a full end-to-end path registered.
describe('MODEL_CATALOG integrity', () => {
  for (const entry of MODEL_CATALOG) {
    describe(entry.id, () => {
      it('has an entry in MODEL_TO_PROVIDER', () => {
        expect(MODEL_TO_PROVIDER[entry.id]).toBeDefined()
      })

      it('routes to a provider that exists in PROVIDERS', () => {
        const providerKey = MODEL_TO_PROVIDER[entry.id]
        expect(PROVIDERS[providerKey]).toBeDefined()
        // Allow template URLs (e.g. {VERTEX_AIG_BASE_URL}/...) as well as plain http(s)
        expect(PROVIDERS[providerKey].apiUrl).toMatch(/^(https?:\/\/|\{)/)
      })

      it('has a context-window budget registered', () => {
        expect(MODEL_CONTEXT_BUDGET[entry.id]).toBeGreaterThan(0)
      })

      it('resolveProviderModelId produces a non-empty upstream id', () => {
        const upstream = resolveProviderModelId(entry.id, MODEL_TO_PROVIDER[entry.id])
        expect(typeof upstream).toBe('string')
        expect(upstream.length).toBeGreaterThan(0)
      })
    })
  }
})

describe('resolveModelAndProvider fails closed on unknown models', () => {
  it('returns null when the plan references an unregistered model', () => {
    const plan: PlanConfig = {
      planId: 'pro',
      model: 'totally-fake-model-9000',
      provider: 'some-provider',
      requestsPerMinute: 999_999,
      requestsPerDay: 999_999,
      tokenBudget: 1_000_000,
      planModel: 'glm-5.1',
      planModelProvider: 'dashscope',
      planFallbackModel: 'glm-5.1',
      byokAllowed: false,
    }
    expect(resolveModelAndProvider(plan, 'production')).toBeNull()
  })
})
