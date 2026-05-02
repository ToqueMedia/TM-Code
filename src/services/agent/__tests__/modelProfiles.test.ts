import {
  getModelProfile,
  getAllModelProfiles,
  getProfileForPlan,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
} from '../modelProfiles'

describe('modelProfiles', () => {
  describe('MODEL_PROFILES registry', () => {
    it('contains exactly the two production request shapes', () => {
      // Frontend ships only the two profiles getProfileForPlan returns —
      // V4-Flash for explorer/vibe and GLM-5.1 for pro/max. Every other
      // catalog entry is admin-routable; the proxy normalizes whichever
      // shape we send to that upstream's contract.
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).toContain('deepseek-v4-flash')
      expect(ids).toContain('glm-5.1')
      expect(ids.length).toBe(2)
    })

    it('deepseek-v4-flash has correct specs', () => {
      const v4 = MODEL_PROFILES['deepseek-v4-flash']
      expect(v4.thinkingMode).toBe('toggleable')
      expect(v4.thinkingParam).toBe('enable_thinking')
      expect(v4.supportsSearch).toBe(true)
    })
  })

  describe('getModelProfile', () => {
    it('returns the correct profile by ID', () => {
      const profile = getModelProfile('glm-5.1')
      expect(profile.id).toBe('glm-5.1')
      expect(profile.name).toBe('GLM-5.1')
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
      expect(all.length).toBe(2)
    })
  })

  // ─── Plan-based profile lookup ───
  // Model is decided by backend (Firestore subscription_plans). Frontend uses
  // getProfileForPlan to shape the request body (sampling + thinking-param
  // format). Multimodal (images) is handled server-side in multimodal.ts —
  // not by swapping profiles here.

  describe('getProfileForPlan', () => {
    it('explorer (free) returns DeepSeek V4-Flash', () => {
      const profile = getProfileForPlan('explorer')
      expect(profile.id).toBe('deepseek-v4-flash')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.thinkingParam).toBe('enable_thinking')
    })

    it('vibe returns DeepSeek V4-Flash (entry paid tier)', () => {
      expect(getProfileForPlan('vibe').id).toBe('deepseek-v4-flash')
    })

    it('pro returns GLM-5.1', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.id).toBe('glm-5.1')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.thinkingParam).toBe('reasoning')
      expect(profile.preserveReasoning).toBe(true)
    })

    it('max plan returns GLM-5.1', () => {
      expect(getProfileForPlan('max').id).toBe('glm-5.1')
    })

    it('GLM-5.1 has 200K context window', () => {
      expect(getProfileForPlan('pro').contextWindow).toBe(200_000)
    })

    it('DeepSeek V4-Flash and GLM-5.1 both have toggleable thinking', () => {
      expect(getProfileForPlan('explorer').thinkingMode).toBe('toggleable')
      expect(getProfileForPlan('pro').thinkingMode).toBe('toggleable')
    })
  })
})
