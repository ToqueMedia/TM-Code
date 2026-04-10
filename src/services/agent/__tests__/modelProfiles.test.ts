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
      expect(profile.thinkingMode).toBe('toggleable')
    })

    it('pro returns Kimi K2.5', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.id).toBe('kimi-k2.5')
      expect(profile.preserveReasoning).toBe(true)
      expect(profile.supportsAttachments).toBe(true)
    })

    it('business plans return Kimi K2.5', () => {
      expect(getProfileForPlan('business-4x').id).toBe('kimi-k2.5')
      expect(getProfileForPlan('business-8x').id).toBe('kimi-k2.5')
    })

    it('Kimi K2.5 has temperature 1.0 per benchmark docs', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.temperature).toBe(1.0)
      expect(profile.topP).toBe(0.95)
    })

    it('both models have toggleable thinking', () => {
      expect(getProfileForPlan('explorer').thinkingMode).toBe('toggleable')
      expect(getProfileForPlan('pro').thinkingMode).toBe('toggleable')
    })
  })

  describe('getDefaultModelForPlan (compat)', () => {
    it('explorer defaults to deepseek-v3.2', () => {
      expect(getDefaultModelForPlan('explorer')).toBe('deepseek-v3.2')
    })

    it('paid plans default to kimi-k2.5', () => {
      expect(getDefaultModelForPlan('pro')).toBe('kimi-k2.5')
    })
  })
})
