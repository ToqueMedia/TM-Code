import {
  getModelProfile,
  getProfileForPlan,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
} from '../modelProfiles'

describe('modelProfiles', () => {
  describe('MODEL_PROFILES registry', () => {
    it('contains the expected model + alias keys', () => {
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).toContain('mimo-v2.5-pro-1m')
      expect(ids).toContain('glm-5.2')
      // DashScope (US) pode reportar o id base 'glm-5' — alias para o MESMO
      // perfil do glm-5.2, senão o lookup cai no default ao rotear por DashScope.
      expect(ids).toContain('glm-5')
      expect(MODEL_PROFILES['glm-5']).toBe(MODEL_PROFILES['glm-5.2'])
      expect(ids).toContain('deepseek-v4-pro')
      expect(ids).toContain('qwen3.7-max-2026-06-08')
      // Alias do id antigo → mesmo perfil do snapshot datado.
      expect(MODEL_PROFILES['qwen3.7-max']).toBe(MODEL_PROFILES['qwen3.7-max-2026-06-08'])
      expect(ids).toContain('mimo-v2.5-1m')
      // Gemini: id do preset + id raw com prefixo de publisher → mesmo perfil.
      expect(MODEL_PROFILES['google/gemini-3.5-flash']).toBe(MODEL_PROFILES['gemini-3.5-flash'])
      expect(MODEL_PROFILES['google/gemini-3.1-pro-preview']).toBe(MODEL_PROFILES['gemini-3.1-pro-preview'])
      expect(ids).toContain('kimi-k2.7-code')
    })

    it('glm-5.2 has 1M context, 128K output, toggleable thinking, no native vision', () => {
      const glm = MODEL_PROFILES['glm-5.2']
      expect(glm.modelId).toBe('glm-5.2')
      expect(glm.contextWindow).toBe(1_000_000)
      expect(glm.maxOutputTokens).toBe(131_072)
      expect(glm.thinkingMode).toBe('toggleable')
      expect(glm.supportsThinking).toBe(true)
      // Visão servida pelo sidecar, não nativamente.
      expect(glm.supportsAttachments).toBe(false)
    })

    it('deepseek-v4-pro has 1M context, 384K output, toggleable thinking, text-only', () => {
      const deepseek = MODEL_PROFILES['deepseek-v4-pro']
      expect(deepseek.modelId).toBe('deepseek-v4-pro')
      expect(deepseek.contextWindow).toBe(1_000_000)
      expect(deepseek.maxOutputTokens).toBe(393_216)
      expect(deepseek.thinkingMode).toBe('toggleable')
      expect(deepseek.supportsThinking).toBe(true)
      expect(deepseek.supportsAttachments).toBe(false)
      expect(deepseek.supportsSearch).toBe(false)
    })

    it('gemini profiles have native vision and mandatory thinking', () => {
      const gemini = MODEL_PROFILES['gemini-3.5-flash']
      expect(gemini.supportsAttachments).toBe(true)
      expect(gemini.thinkingMandatory).toBe(true)
    })

    it('qwen3.7-max-2026-06-08 has native vision and search', () => {
      const qwen = MODEL_PROFILES['qwen3.7-max-2026-06-08']
      expect(qwen.modelId).toBe('qwen3.7-max-2026-06-08')
      expect(qwen.supportsAttachments).toBe(true)
      expect(qwen.supportsSearch).toBe(true)
    })

    it('kimi-k2.7-code has 256K context, native vision/search and toggleable thinking', () => {
      const kimi = MODEL_PROFILES['kimi-k2.7-code']
      expect(kimi.modelId).toBe('kimi-k2.7-code')
      expect(kimi.contextWindow).toBe(262_144)
      expect(kimi.maxOutputTokens).toBe(32_768)
      expect(kimi.supportsAttachments).toBe(true)
      expect(kimi.supportsSearch).toBe(true)
      expect(kimi.thinkingMode).toBe('toggleable')
      expect(kimi.supportsThinking).toBe(true)
    })

    it('mimo-v2.5-pro-1m has correct specs', () => {
      const mimo = MODEL_PROFILES['mimo-v2.5-pro-1m']
      expect(mimo.thinkingMode).toBe('toggleable')
      expect(mimo.supportsThinking).toBe(true)
      expect(mimo.contextWindow).toBe(1_048_576)
      expect(mimo.maxOutputTokens).toBe(32_768)
    })
  })

  describe('getModelProfile', () => {
    it('returns MiMo profile by ID', () => {
      const profile = getModelProfile('mimo-v2.5-pro-1m')
      expect(profile.id).toBe('mimo-v2.5-pro-1m')
      expect(profile.name).toBe('MiMo V2.5 Pro 1M')
    })

    it('falls back to default model for unknown ID', () => {
      const profile = getModelProfile('nonexistent-model')
      expect(profile.id).toBe(DEFAULT_MODEL_ID)
    })
  })

  describe('getProfileForPlan', () => {
    it('always returns MiMo regardless of plan', () => {
      expect(getProfileForPlan('explorer').id).toBe('mimo-v2.5-pro-1m')
      expect(getProfileForPlan('vibe').id).toBe('mimo-v2.5-pro-1m')
      expect(getProfileForPlan('pro').id).toBe('mimo-v2.5-pro-1m')
      expect(getProfileForPlan('max').id).toBe('mimo-v2.5-pro-1m')
      expect(getProfileForPlan('welcome').id).toBe('mimo-v2.5-pro-1m')
    })

    it('returned profile has toggleable thinking and 1M context', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.contextWindow).toBe(1_048_576)
    })
  })
})
