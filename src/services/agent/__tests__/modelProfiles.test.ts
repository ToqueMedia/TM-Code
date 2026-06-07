import {
  getModelProfile,
  getAllModelProfiles,
  getProfileForPlan,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
} from '../modelProfiles'

describe('modelProfiles', () => {
  describe('MODEL_PROFILES registry', () => {
    it('contains all 4 model profiles', () => {
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).toContain('mimo-v2.5-pro-1m')
      expect(ids).toContain('glm-5.1')
      expect(ids).toContain('qwen3.7-max')
      expect(ids).toContain('mimo-v2.5-1m')
      expect(ids.length).toBe(4)
    })

    it('mimo-v2.5-pro-1m has correct specs', () => {
      const mimo = MODEL_PROFILES['mimo-v2.5-pro-1m']
      expect(mimo.thinkingMode).toBe('toggleable')
      expect(mimo.thinkingParam).toBe('enable_thinking')
      expect(mimo.supportsThinking).toBe(true)
      expect(mimo.contextWindow).toBe(1_048_576)
      expect(mimo.maxOutputTokens).toBe(32_768)
      expect(mimo.temperature).toBe(0.3)
      expect(mimo.topP).toBe(0.95)
      expect(mimo.thinkingBudget).toBe(8192)
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

  describe('getAllModelProfiles', () => {
    it('returns all 4 profiles', () => {
      const all = getAllModelProfiles()
      expect(all.length).toBe(4)
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

    it('returned profile has toggleable thinking', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.thinkingParam).toBe('enable_thinking')
    })

    it('returned profile has 1M context window', () => {
      expect(getProfileForPlan('pro').contextWindow).toBe(1_048_576)
    })
  })
})
