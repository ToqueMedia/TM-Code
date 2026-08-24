import 'openai/shims/node'
import { normalizeByokBaseURL } from '../sdkClient'

describe('normalizeByokBaseURL', () => {
  it('adds /v1 to local OpenAI-compat hosts without it', () => {
    expect(normalizeByokBaseURL('http://localhost:11434', 'openai_compat')).toBe('http://localhost:11434/v1')
    expect(normalizeByokBaseURL('http://127.0.0.1:1234', 'openai_compat')).toBe('http://127.0.0.1:1234/v1')
    expect(normalizeByokBaseURL('http://localhost:11434/', 'openai_compat')).toBe('http://localhost:11434/v1')
  })

  it('keeps /v1 when already present on local hosts', () => {
    expect(normalizeByokBaseURL('http://localhost:11434/v1', 'openai_compat')).toBe('http://localhost:11434/v1')
    expect(normalizeByokBaseURL('http://localhost:1234/v1/', 'openai_compat')).toBe('http://localhost:1234/v1')
  })

  it('preserves non-local OpenAI-compat roots (cloud / custom)', () => {
    // Gemini's /v1beta/openai must not become /v1beta/openai/v1.
    expect(normalizeByokBaseURL('https://generativelanguage.googleapis.com/v1beta/openai', 'openai_compat'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    // Standard OpenAI / DashScope roots stay untouched.
    expect(normalizeByokBaseURL('https://api.openai.com/v1', 'openai_compat')).toBe('https://api.openai.com/v1')
    expect(normalizeByokBaseURL('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'openai_compat'))
      .toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
    // Non-local custom providers are left as-is — the user is responsible for
    // their API root suffix.
    expect(normalizeByokBaseURL('https://my-gateway.local/api/v2', 'openai_compat'))
      .toBe('https://my-gateway.local/api/v2')
  })

  it('does not alter Anthropic shape', () => {
    expect(normalizeByokBaseURL('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeByokBaseURL('https://api.anthropic.com/', 'anthropic')).toBe('https://api.anthropic.com')
  })
})
