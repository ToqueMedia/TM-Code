import {
  getModelProfile,
  getAllModelProfiles,
  getModelsForPlan,
  getDefaultModelForPlan,
  isModelAvailableForPlan,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
  FREE_MODEL_ID,
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

  describe('getModelsForPlan', () => {
    it('explorer (free) only gets mimo-v2-flash', () => {
      const models = getModelsForPlan('explorer')
      expect(models.length).toBe(1)
      expect(models[0].id).toBe(FREE_MODEL_ID)
    })

    it('pro gets all models EXCEPT mimo', () => {
      const models = getModelsForPlan('pro')
      expect(models.every(m => m.id !== FREE_MODEL_ID)).toBe(true)
      expect(models.length).toBe(8)
    })

    it('business-4x gets all models EXCEPT mimo', () => {
      const models = getModelsForPlan('business-4x')
      expect(models.every(m => m.id !== FREE_MODEL_ID)).toBe(true)
      expect(models.length).toBe(8)
    })

    it('business-8x gets all models EXCEPT mimo', () => {
      const models = getModelsForPlan('business-8x')
      expect(models.every(m => m.id !== FREE_MODEL_ID)).toBe(true)
      expect(models.length).toBe(8)
    })
  })

  describe('getDefaultModelForPlan', () => {
    it('explorer defaults to mimo-v2-flash', () => {
      expect(getDefaultModelForPlan('explorer')).toBe(FREE_MODEL_ID)
    })

    it('paid plans default to deepseek-v3.2', () => {
      expect(getDefaultModelForPlan('pro')).toBe(DEFAULT_MODEL_ID)
      expect(getDefaultModelForPlan('business-4x')).toBe(DEFAULT_MODEL_ID)
      expect(getDefaultModelForPlan('business-8x')).toBe(DEFAULT_MODEL_ID)
    })
  })

  describe('isModelAvailableForPlan', () => {
    it('mimo only available for explorer', () => {
      expect(isModelAvailableForPlan('mimo-v2-flash', 'explorer')).toBe(true)
      expect(isModelAvailableForPlan('mimo-v2-flash', 'pro')).toBe(false)
      expect(isModelAvailableForPlan('mimo-v2-flash', 'business-8x')).toBe(false)
    })

    it('deepseek not available for explorer', () => {
      expect(isModelAvailableForPlan('deepseek-v3.2', 'explorer')).toBe(false)
    })

    it('deepseek available for all paid plans', () => {
      expect(isModelAvailableForPlan('deepseek-v3.2', 'pro')).toBe(true)
      expect(isModelAvailableForPlan('deepseek-v3.2', 'business-4x')).toBe(true)
      expect(isModelAvailableForPlan('deepseek-v3.2', 'business-8x')).toBe(true)
    })
  })
})
