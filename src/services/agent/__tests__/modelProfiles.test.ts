import {
  getModelProfile,
  getAllModelProfiles,
  getProfileForPlan,
  getMultimodalProfile,
  hasMultimodalContent,
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
      expect(ids).toContain('deepseek-v4-flash')
      expect(ids).toContain('step-3.5-flash')
      expect(ids).toContain('glm-5')
      expect(ids).toContain('glm-5.1')
      expect(ids).toContain('kimi-k2.5')
      expect(ids).toContain('qwen3-coder-next')
      expect(ids).toContain('minimax-m2.5')
      expect(ids).toContain('qwen3.6-plus')
      expect(ids).toContain('gemini-3-flash')
      expect(ids.length).toBe(10)
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

    it('returns GLM-5.1 profile with OpenRouter config', () => {
      const profile = getModelProfile('glm-5.1')
      expect(profile.id).toBe('glm-5.1')
      expect(profile.name).toBe('GLM-5.1')
      expect(profile.modelId).toBe('Z-AI/GLM-5.1')
      expect(profile.contextWindow).toBe(200_000)
      expect(profile.maxOutputTokens).toBe(32_768)
      // Official z.ai benchmark params: temp=1.0, top_p=0.95 (SWE-Bench Pro)
      expect(profile.temperature).toBe(1.0)
      expect(profile.topP).toBe(0.95)
      expect(profile.topPNonThinking).toBe(0.95)  // Safer for tool calling — avoids malformed JSON args
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.thinkingParam).toBe('reasoning')
      expect(profile.preserveReasoning).toBe(true)
    })

    it('falls back to default model for unknown ID', () => {
      const profile = getModelProfile('nonexistent-model')
      expect(profile.id).toBe(DEFAULT_MODEL_ID)
    })
  })

  describe('getAllModelProfiles', () => {
    it('returns all profiles', () => {
      const all = getAllModelProfiles()
      expect(all.length).toBe(10)
    })
  })

  // ─── Plan-based profile lookup (replaces model selector) ───
  // Model is decided by backend based on plan. Frontend uses getProfileForPlan
  // to configure thinking/sampling/compression.
  // Paid plans use GLM-5.1. Qwen 3.6 Plus is reserved for multimodal.

  describe('getProfileForPlan', () => {
    it('explorer (free) returns DeepSeek V4-Flash', () => {
      const profile = getProfileForPlan('explorer')
      expect(profile.id).toBe('deepseek-v4-flash')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.thinkingParam).toBe('enable_thinking')
    })

    it('pro returns GLM-5.1', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.id).toBe('glm-5.1')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.thinkingParam).toBe('reasoning')
      expect(profile.preserveReasoning).toBe(true)
    })

    it('business plans return GLM-5.1', () => {
      expect(getProfileForPlan('business-4x').id).toBe('glm-5.1')
      expect(getProfileForPlan('business-8x').id).toBe('glm-5.1')
    })

    it('GLM-5.1 has 200K context window', () => {
      expect(getProfileForPlan('pro').contextWindow).toBe(200_000)
    })

    it('DeepSeek V4-Flash and GLM-5.1 both have toggleable thinking', () => {
      expect(getProfileForPlan('explorer').thinkingMode).toBe('toggleable')
      expect(getProfileForPlan('pro').thinkingMode).toBe('toggleable')
    })
  })

  describe('getMultimodalProfile', () => {
    it('returns Qwen 3.6 Plus for image analysis', () => {
      const profile = getMultimodalProfile()
      expect(profile.id).toBe('qwen3.6-plus')
      expect(profile.supportsAttachments).toBe(true)
      expect(profile.contextWindow).toBe(1_000_000)
    })
  })

  describe('hasMultimodalContent', () => {
    it('returns false for string messages', () => {
      expect(hasMultimodalContent('Hello world')).toBe(false)
    })

    it('returns false for text-only content parts', () => {
      expect(hasMultimodalContent([{ type: 'text', text: 'Hello' } as any])).toBe(false)
    })

    it('returns true for image_url content parts', () => {
      expect(hasMultimodalContent([
        { type: 'text', text: 'What is this?' } as any,
        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } } as any,
      ])).toBe(true)
    })
  })

})
