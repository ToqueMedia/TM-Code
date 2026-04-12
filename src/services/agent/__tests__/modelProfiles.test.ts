import {
  getModelProfile,
  getAllModelProfiles,
  getProfileForPlan,
  getDefaultModelForPlan,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
} from '../modelProfiles'

describe('modelProfiles', () => {
  describe('MODEL_PROFILES registry', () => {
    it('contains mimo-v2-flash', () => {
      expect(MODEL_PROFILES['mimo-v2-flash']).toBeDefined()
      expect(MODEL_PROFILES['mimo-v2-flash'].persona.name).toBe('Free')
    })

    it('contains all expected models', () => {
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).toContain('mimo-v2-flash')
      expect(ids).toContain('deepseek-v3.2')
      expect(ids).toContain('step-3.5-flash')
      expect(ids).toContain('glm-5')
      expect(ids).toContain('kimi-k2.5')
      expect(ids).toContain('qwen3-coder-next')
      expect(ids).toContain('minimax-m2.5')
      expect(ids).toContain('qwen3.6-plus')
      expect(ids).toContain('gemini-3-flash')
      expect(ids.length).toBe(9)
    })

    it('mimo-v2-flash has correct specs', () => {
      const mimo = MODEL_PROFILES['mimo-v2-flash']
      expect(mimo.contextWindow).toBe(262_144)
      expect(mimo.maxOutputTokens).toBe(65_536)
      expect(mimo.temperature).toBe(0.3)
      expect(mimo.topP).toBe(0.95)
      expect(mimo.supportsThinking).toBe(false)
      expect(mimo.supportsAttachments).toBe(false)
    })
  })

  describe('getModelProfile', () => {
    it('returns the correct profile by ID', () => {
      const profile = getModelProfile('glm-5')
      expect(profile.id).toBe('glm-5')
      expect(profile.name).toBe('GLM-5')
    })

    it('falls back to default model for unknown ID', () => {
      const profile = getModelProfile('nonexistent-model')
      expect(profile.id).toBe(DEFAULT_MODEL_ID)
    })
  })

  describe('getAllModelProfiles', () => {
    it('returns all profiles', () => {
      const all = getAllModelProfiles()
      expect(all.length).toBe(9)
    })
  })

  // ─── Plan-based profile lookup (replaces model selector) ───
  // Model is decided by backend based on plan. Frontend uses getProfileForPlan
  // to configure thinking/sampling/compression.

  describe('getProfileForPlan', () => {
    it('explorer (free) returns DeepSeek V3.2', () => {
      const profile = getProfileForPlan('explorer')
      expect(profile.id).toBe('deepseek-v3.2')
      expect(profile.thinkingMode).toBe('none')
      expect(profile.supportsThinking).toBe(false)
    })

    it('pro returns Qwen 3.6 Plus', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.id).toBe('qwen3.6-plus')
      // Qwen3 official: do NOT preserve reasoning in multi-turn history
      expect(profile.preserveReasoning).toBe(false)
      expect(profile.supportsAttachments).toBe(true)
    })

    it('business plans return Qwen 3.6 Plus', () => {
      expect(getProfileForPlan('business-4x').id).toBe('qwen3.6-plus')
      expect(getProfileForPlan('business-8x').id).toBe('qwen3.6-plus')
    })

    it('Qwen 3.6 Plus has 1M context window', () => {
      expect(getProfileForPlan('pro').contextWindow).toBe(1_000_000)
    })

    it('DeepSeek has no thinking, Qwen has toggleable', () => {
      expect(getProfileForPlan('explorer').thinkingMode).toBe('none')
      expect(getProfileForPlan('pro').thinkingMode).toBe('toggleable')
    })
  })

  describe('getDefaultModelForPlan (compat)', () => {
    it('explorer defaults to deepseek-v3.2', () => {
      expect(getDefaultModelForPlan('explorer')).toBe('deepseek-v3.2')
    })

    it('paid plans default to qwen3.6-plus', () => {
      expect(getDefaultModelForPlan('pro')).toBe('qwen3.6-plus')
    })
  })
})
