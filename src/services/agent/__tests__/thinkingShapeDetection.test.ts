/**
 * Pins the per-host thinking-shape lookup. baseURL is the ground truth
 * for what the upstream accepts — if this table drifts from reality,
 * the model silently keeps reasoning (we lived this bug with
 * Mimo-via-OpenRouter shipped with the OpenAI shape). The tests make
 * the host→shape contract a hard regression gate.
 */
import { detectThinkingShapeFromBaseURL, resolveThinkingHint } from '../thinkingShapeDetection'

describe('detectThinkingShapeFromBaseURL', () => {
  it('returns null on empty / unknown host', () => {
    expect(detectThinkingShapeFromBaseURL('')).toBeNull()
    expect(detectThinkingShapeFromBaseURL('https://example.com/v1')).toBeNull()
    expect(detectThinkingShapeFromBaseURL('https://my-self-hosted-llm.io')).toBeNull()
  })

  it('returns null on malformed URL (parser failure)', () => {
    expect(detectThinkingShapeFromBaseURL('not-a-url')).toBeNull()
    expect(detectThinkingShapeFromBaseURL('://broken')).toBeNull()
  })

  describe('host parsing (anti-spoofing)', () => {
    it('does NOT match openrouter.ai when it appears in path or query', () => {
      // The .includes() implementation would falsely match these; URL
      // parsing extracts the hostname and matches against THAT only.
      expect(detectThinkingShapeFromBaseURL('https://evil.com/?u=openrouter.ai')).toBeNull()
      expect(detectThinkingShapeFromBaseURL('https://attacker.com/openrouter.ai/v1')).toBeNull()
    })
    it('does NOT match a host that merely contains a known fragment', () => {
      // openrouter-fake.com is not openrouter.ai. endsWith guards this.
      expect(detectThinkingShapeFromBaseURL('https://openrouter-fake.com')).toBeNull()
    })
  })

  describe('OpenRouter', () => {
    it('matches the canonical host', () => {
      expect(detectThinkingShapeFromBaseURL('https://openrouter.ai/api/v1'))
        .toBe('openrouter_reasoning')
    })
    it('matches with subpath', () => {
      expect(detectThinkingShapeFromBaseURL('https://openrouter.ai/api/v1/chat/completions'))
        .toBe('openrouter_reasoning')
    })
    it('matches case-insensitively', () => {
      expect(detectThinkingShapeFromBaseURL('https://OpenRouter.AI/api/v1'))
        .toBe('openrouter_reasoning')
    })
  })

  describe('Xiaomi MiMo', () => {
    it('matches the official platform host', () => {
      expect(detectThinkingShapeFromBaseURL('https://platform.xiaomimimo.com/v1'))
        .toBe('mimo_chat_template_kwargs')
    })
    it('matches mimo.xiaomi.com subdomain', () => {
      expect(detectThinkingShapeFromBaseURL('https://mimo.xiaomi.com/v1'))
        .toBe('mimo_chat_template_kwargs')
    })
    it('does NOT match unrelated xiaomi hosts', () => {
      expect(detectThinkingShapeFromBaseURL('https://www.xiaomi.com')).toBeNull()
    })
  })

  describe('Anthropic', () => {
    it('matches the canonical host', () => {
      expect(detectThinkingShapeFromBaseURL('https://api.anthropic.com/v1'))
        .toBe('anthropic')
    })
  })

  describe('DashScope / Qwen', () => {
    it('matches international DashScope', () => {
      expect(detectThinkingShapeFromBaseURL('https://dashscope.aliyuncs.com/compatible-mode/v1'))
        .toBe('qwen_enable_thinking')
    })
    it('matches intl region subdomain', () => {
      expect(detectThinkingShapeFromBaseURL('https://dashscope-intl.aliyuncs.com/api/v1'))
        .toBe('qwen_enable_thinking')
    })
  })

  describe('Google Gemini', () => {
    it('matches the generative-language host', () => {
      expect(detectThinkingShapeFromBaseURL('https://generativelanguage.googleapis.com/v1beta'))
        .toBe('openai_reasoning_effort')
    })
  })

  describe('OpenAI', () => {
    it('matches the canonical host', () => {
      expect(detectThinkingShapeFromBaseURL('https://api.openai.com/v1'))
        .toBe('openai_reasoning_effort')
    })
    it('does NOT match Azure OpenAI (different host)', () => {
      // Azure OpenAI uses different hosts (e.g. *.openai.azure.com).
      // Documented limitation — Azure routing through the official
      // openai SDK does work, but auto-detection would need a separate
      // pattern. Leaving null preserves catalog fallback.
      expect(detectThinkingShapeFromBaseURL('https://my-resource.openai.azure.com/v1'))
        .toBeNull()
    })
  })

  describe('StepFun', () => {
    it('matches the canonical API host', () => {
      expect(detectThinkingShapeFromBaseURL('https://api.stepfun.ai/v1'))
        .toBe('openai_reasoning_effort')
    })
    it('matches StepFun subdomains', () => {
      expect(detectThinkingShapeFromBaseURL('https://gateway.stepfun.ai/v1'))
        .toBe('openai_reasoning_effort')
    })
  })

  describe('Moonshot Kimi', () => {
    it('matches the international api host', () => {
      expect(detectThinkingShapeFromBaseURL('https://api.moonshot.ai/v1'))
        .toBe('moonshot_thinking')
    })
    it('matches the .cn regional host', () => {
      expect(detectThinkingShapeFromBaseURL('https://api.moonshot.cn/v1'))
        .toBe('moonshot_thinking')
    })
    it('matches subdomains', () => {
      expect(detectThinkingShapeFromBaseURL('https://platform.moonshot.ai/v1'))
        .toBe('moonshot_thinking')
    })
    it('does NOT match an unrelated host that merely contains "moonshot"', () => {
      expect(detectThinkingShapeFromBaseURL('https://moonshot-fake.com')).toBeNull()
    })
  })

  describe('precedence — exclusive by host', () => {
    it('OpenRouter wins even if mimo word appears in path', () => {
      // OpenRouter routes can have model ids like xiaomi/mimo-v2.5-pro in
      // the path. Detection looks at HOST not path — openrouter.ai
      // matches first, mimo_chat_template_kwargs would be a bug.
      expect(detectThinkingShapeFromBaseURL('https://openrouter.ai/api/v1/xiaomi/mimo-v2.5-pro'))
        .toBe('openrouter_reasoning')
    })
  })
})

describe('resolveThinkingHint', () => {
  describe('known host wins over catalog', () => {
    it('Mimo via OpenRouter: catalog has openai shape, host detection forces openrouter', () => {
      // This is the EXACT regression that motivated this whole module.
      // Catalog claims `openai_reasoning_effort` (the bug); URL says
      // openrouter.ai. The resolver must trust the URL.
      const hint = resolveThinkingHint({
        baseURL: 'https://openrouter.ai/api/v1',
        catalogSupportsThinking: true,
        catalogShape: 'openai_reasoning_effort',
      })
      expect(hint.thinkingShape).toBe('openrouter_reasoning')
      expect(hint.supportsThinking).toBe(true)
    })

    it('Mimo via official Xiaomi API: detects mimo shape regardless of catalog', () => {
      const hint = resolveThinkingHint({
        baseURL: 'https://platform.xiaomimimo.com/v1',
        catalogSupportsThinking: undefined,
        catalogShape: undefined,
      })
      expect(hint.thinkingShape).toBe('mimo_chat_template_kwargs')
      // Defaults to supportsThinking=true on a known host, even when the
      // catalog said nothing — the disable param is harmless if unused.
      expect(hint.supportsThinking).toBe(true)
    })

    it('catalog says supportsThinking=false on a known host — IGNORED', () => {
      // Real session regression (2026-05-13): user-defined Custom BYOK to
      // api.xiaomimimo.com had `supportsThinking: false` in the snapshot
      // (the user didn't know the model reasoned). The model reasoned
      // anyway. Previous rule respected the catalog's false → no disable
      // param → unwanted chain-of-thought. New rule: known host always
      // forces supportsThinking=true, the catalog flag is ignored. The
      // disable param is harmless on truly non-reasoning models.
      const hint = resolveThinkingHint({
        baseURL: 'https://api.xiaomimimo.com/v1',
        catalogSupportsThinking: false,
        catalogShape: undefined,
      })
      expect(hint.thinkingShape).toBe('mimo_chat_template_kwargs')
      expect(hint.supportsThinking).toBe(true)
    })

    it('OpenRouter: catalog says supportsThinking=false — also IGNORED', () => {
      // Same rule applies regardless of provider — host-level decision.
      const hint = resolveThinkingHint({
        baseURL: 'https://openrouter.ai/api/v1',
        catalogSupportsThinking: false,
        catalogShape: undefined,
      })
      expect(hint.thinkingShape).toBe('openrouter_reasoning')
      expect(hint.supportsThinking).toBe(true)
    })
  })

  describe('unknown host falls back to catalog', () => {
    it('self-hosted SGLang: uses catalog shape verbatim', () => {
      const hint = resolveThinkingHint({
        baseURL: 'https://my-llm.example.com/v1',
        catalogSupportsThinking: true,
        catalogShape: 'qwen_enable_thinking',
      })
      expect(hint.thinkingShape).toBe('qwen_enable_thinking')
      expect(hint.supportsThinking).toBe(true)
    })

    it('self-hosted with no catalog hint: returns null shape, supportsThinking=false', () => {
      const hint = resolveThinkingHint({
        baseURL: 'https://my-llm.example.com/v1',
        catalogSupportsThinking: undefined,
        catalogShape: undefined,
      })
      expect(hint.thinkingShape).toBeUndefined()
      expect(hint.supportsThinking).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('empty baseURL with catalog hint: catalog wins', () => {
      const hint = resolveThinkingHint({
        baseURL: '',
        catalogSupportsThinking: true,
        catalogShape: 'anthropic',
      })
      expect(hint.thinkingShape).toBe('anthropic')
      expect(hint.supportsThinking).toBe(true)
    })
  })
})
