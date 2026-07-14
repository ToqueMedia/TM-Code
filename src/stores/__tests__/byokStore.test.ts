import { inferLocalModelCapabilities } from '../byokModelCapabilities'
import { cleanBaseURL } from '../byokBaseURL'

// Pins the URL-suffix stripping contract. Users routinely paste the
// full endpoint from provider docs ("https://api.stepfun.ai/v1/chat/completions");
// the helper must drop only the OpenAI-compat path suffix so the stored
// baseURL keeps its `/v1` (the worker appends `/chat/completions` to it).
// A previous bug stripped `/v1` as well and produced 404s upstream.
describe('cleanBaseURL', () => {
  test('strips trailing slash', () => {
    expect(cleanBaseURL('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(cleanBaseURL('https://api.openai.com/v1//')).toBe('https://api.openai.com/v1')
  })

  test('strips /chat/completions and keeps /v1 (OpenAI-compat convention)', () => {
    // The bug this guards against: stepfun.ai/v1/chat/completions used to
    // collapse to stepfun.ai and the worker would then call …/chat/completions
    // (no /v1) which 404s upstream.
    expect(cleanBaseURL('https://api.stepfun.ai/v1/chat/completions'))
      .toBe('https://api.stepfun.ai/v1')
    expect(cleanBaseURL('https://api.openai.com/v1/chat/completions'))
      .toBe('https://api.openai.com/v1')
    expect(cleanBaseURL('https://api.deepseek.com/v1/chat/completions/'))
      .toBe('https://api.deepseek.com/v1')
  })

  test('strips /chat/completions when /v1 is absent', () => {
    expect(cleanBaseURL('https://my-gateway.local/chat/completions'))
      .toBe('https://my-gateway.local')
  })

  test('strips /v1/messages entirely (Anthropic convention — base has no /v1)', () => {
    expect(cleanBaseURL('https://api.anthropic.com/v1/messages'))
      .toBe('https://api.anthropic.com')
  })

  test('strips Ollama and Responses suffixes', () => {
    expect(cleanBaseURL('http://localhost:11434/api/chat')).toBe('http://localhost:11434')
    expect(cleanBaseURL('http://localhost:11434/api/generate')).toBe('http://localhost:11434')
    expect(cleanBaseURL('https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1')
  })

  test('returns undefined for empty / whitespace input', () => {
    expect(cleanBaseURL(undefined)).toBeUndefined()
    expect(cleanBaseURL('')).toBeUndefined()
    expect(cleanBaseURL('   ')).toBeUndefined()
  })

  test('leaves a clean baseURL unchanged', () => {
    expect(cleanBaseURL('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(cleanBaseURL('https://api.anthropic.com')).toBe('https://api.anthropic.com')
  })
})

// Family-level expectations. The heuristic gates whether the agent exposes
// tools to a local model — getting these wrong means the agent silently
// falls back to plain chat (no edits, no commands), so a regression here
// would be very visible to users.

describe('inferLocalModelCapabilities — tools', () => {
  test.each([
    // Qwen 2.5+
    ['qwen2.5:7b'],
    ['qwen2.5-coder:7b'],
    ['qwen3:8b'],
    ['qwen3:30b'],
    ['qwen3-coder:7b'],
    // Llama 3.1+
    ['llama3.1:8b'],
    ['llama3.1:70b'],
    ['llama3.2:3b'],
    ['llama3.3:70b'],
    ['llama4:scout'],
    ['llama4:maverick'],
    // Mistral / Mixtral
    ['mistral:7b'],
    ['mistral-nemo:12b'],
    ['mistral-large:123b'],
    ['mixtral:8x7b'],
    // Gemma 3+
    ['gemma3:4b'],
    ['gemma3:27b'],
    // Phi 3.5+
    ['phi3.5:3.8b'],
    ['phi4:14b'],
    // gpt-oss
    ['gpt-oss:20b'],
    ['gpt-oss:120b'],
    // Command R
    ['command-r:35b'],
    ['command-r-plus:104b'],
    // Nemotron
    ['nemotron:70b'],
    ['nemotron-mini:4b'],
    // Granite 3+
    ['granite3:8b'],
    ['granite-3.1:8b'],
    // LM Studio path-shaped IDs
    ['bartowski/Llama-3.2-3B-Instruct-GGUF'],
    ['lmstudio-community/qwen3-8b-gguf'],
  ])('tools=true for %s', (id) => {
    expect(inferLocalModelCapabilities(id).capabilities.tools).toBe(true)
  })

  test.each([
    // Llama 3.0 (poor tool support — must opt in via override)
    ['llama3:8b'],
    ['llama3:70b'],
    // Gemma 2 (no native tools)
    ['gemma2:9b'],
    ['gemma2:27b'],
    // Qwen 2 base (pre-2.5)
    ['qwen2:7b'],
    // Phi 3 base (pre-3.5)
    ['phi3:medium'],
    ['phi3:mini'],
    // Reasoning-only families
    ['deepseek-r1:7b'],
    ['qwq:32b'],
    // Embedding / unknown / ad-hoc
    ['nomic-embed-text:latest'],
    ['mymodel:latest'],
    ['random'],
  ])('tools=false for %s', (id) => {
    expect(inferLocalModelCapabilities(id).capabilities.tools).toBe(false)
  })
})

describe('inferLocalModelCapabilities — thinking', () => {
  test.each([
    ['deepseek-r1:7b'],
    ['deepseek-r1:14b'],
    ['deepseekr1:7b'],
    ['qwq:32b'],
    ['qwq-32b-preview'],
    ['qwen3-thinking:30b'],
  ])('supportsThinking=true for %s', (id) => {
    expect(inferLocalModelCapabilities(id).supportsThinking).toBe(true)
  })

  test.each([
    ['qwen3:8b'],
    ['llama3.1:8b'],
    ['gpt-oss:20b'],
  ])('supportsThinking=false for %s', (id) => {
    expect(inferLocalModelCapabilities(id).supportsThinking).toBe(false)
  })
})

describe('inferLocalModelCapabilities — images', () => {
  test.each([
    ['llava:7b'],
    ['llava:13b'],
    ['bakllava:7b'],
    ['moondream:1.8b'],
    ['llama3.2-vision:11b'],
    ['qwen2-vl:7b'],
    ['qwen2.5-vl:7b'],
    ['qwen3-vl:30b'],
  ])('images=true for %s', (id) => {
    expect(inferLocalModelCapabilities(id).capabilities.images).toBe(true)
  })

  test.each([
    ['qwen3:8b'],
    ['llama3.1:8b'],
    ['mistral:7b'],
  ])('images=false for %s', (id) => {
    expect(inferLocalModelCapabilities(id).capabilities.images).toBe(false)
  })
})

describe('inferLocalModelCapabilities — combined (vision + tools)', () => {
  // Llama 3.2-vision and Qwen2.5-VL support BOTH images and tools.
  // The current heuristic correctly flags both because the family-level
  // tools check matches independently of the vision check.
  test('llama3.2-vision:11b → images + tools', () => {
    const r = inferLocalModelCapabilities('llama3.2-vision:11b')
    expect(r.capabilities.images).toBe(true)
    expect(r.capabilities.tools).toBe(true)
  })
  test('qwen2.5-vl:7b → images + tools', () => {
    const r = inferLocalModelCapabilities('qwen2.5-vl:7b')
    expect(r.capabilities.images).toBe(true)
    expect(r.capabilities.tools).toBe(true)
  })
})

describe('byokStore testKey — direct provider validation', () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('validates Anthropic directly against /v1/messages, not the worker validate endpoint', async () => {
    const invokeMock = jest.fn(async (command: string) => {
      if (command === 'byok_has_key') return true
      if (command === 'byok_get_key') return 'sk-ant-test'
      return null
    })
    const tauriFetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }))

    jest.doMock('@/utils/invokeMetrics', () => ({ invoke: invokeMock }))
    jest.doMock('../../services/tauriFetch', () => ({ tauriFetch: tauriFetchMock }))

    const { useByokStore } = await import('../byokStore')
    await useByokStore.getState().loadProviders()

    const result = await useByokStore.getState().testKey('anthropic', 'claude-sonnet-4-6')

    expect(result.valid).toBe(true)
    expect(tauriFetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = tauriFetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(url).not.toContain('/v1/byok/validate')
    expect(options.headers['x-api-key']).toBe('sk-ant-test')
    expect(options.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(options.body)).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 5,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
      stream: false,
    })
  })
})

describe('byokStore catalog — DashScope Kimi', () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('includes Kimi K2.7 Code as a DashScope OpenAI-compatible cloud model', async () => {
    jest.doMock('@/utils/invokeMetrics', () => ({
      invoke: jest.fn(async (command: string) => {
        if (command === 'byok_has_key') return false
        return null
      }),
    }))
    jest.doMock('../../services/tauriFetch', () => ({
      tauriFetch: jest.fn(),
    }))

    const { useByokStore } = await import('../byokStore')
    await useByokStore.getState().loadProviders()

    const provider = useByokStore.getState().providers.find(p => p.id === 'dashscope')
    expect(provider).toMatchObject({
      name: 'DashScope (Alibaba Cloud)',
      group: 'cloud',
      defaultBaseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiShape: 'openai_compat',
    })
    expect(provider?.models).toContainEqual({
      id: 'kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      capabilities: { images: true, audio: false, video: true, tools: true },
      contextWindow: 262_144,
      supportsThinking: true,
      thinkingShape: 'qwen_enable_thinking',
    })
  })
})
