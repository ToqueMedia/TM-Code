import {
  getModelProfile,
  getAllModelProfiles,
  getProfileForPlan,
  buildThinkingParam,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
} from '../modelProfiles'

describe('modelProfiles', () => {
  describe('MODEL_PROFILES registry', () => {
    it('contains all 6 model profiles (plus alias keys)', () => {
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).toContain('mimo-v2.5-pro-1m')
      expect(ids).toContain('glm-5.2')
      // DashScope (US) pode reportar o id base 'glm-5' — alias para o MESMO
      // perfil do glm-5.2, senão o lookup cai no default ao rotear por DashScope.
      expect(ids).toContain('glm-5')
      expect(MODEL_PROFILES['glm-5']).toBe(MODEL_PROFILES['glm-5.2'])
      expect(ids).toContain('qwen3.7-max-2026-06-08')
      // Alias do id antigo — aponta para o MESMO perfil do snapshot datado
      // enquanto o backend não republicar a config ativa.
      expect(ids).toContain('qwen3.7-max')
      expect(MODEL_PROFILES['qwen3.7-max']).toBe(MODEL_PROFILES['qwen3.7-max-2026-06-08'])
      expect(ids).toContain('mimo-v2.5-1m')
      // Gemini: id do preset + id raw com prefixo de publisher (X-TM-Model)
      // apontam para o MESMO perfil.
      expect(MODEL_PROFILES['google/gemini-3.5-flash']).toBe(MODEL_PROFILES['gemini-3.5-flash'])
      expect(MODEL_PROFILES['google/gemini-3.1-pro-preview']).toBe(MODEL_PROFILES['gemini-3.1-pro-preview'])
      expect(ids.length).toBe(10)
    })

    it('glm-5.2 has 1M context, 128K output and the thinking-object shape', () => {
      const glm = MODEL_PROFILES['glm-5.2']
      expect(glm.modelId).toBe('glm-5.2')
      expect(glm.contextWindow).toBe(1_000_000)
      expect(glm.maxOutputTokens).toBe(131_072)
      expect(glm.thinkingMode).toBe('toggleable')
      // z.AI usa o objeto `thinking: { type }`, não o boolean enable_thinking.
      expect(glm.thinkingParam).toBe('thinking')
      expect(glm.supportsThinking).toBe(true)
      // Text-only: a visão é servida pelo sidecar, não nativamente.
      expect(glm.supportsAttachments).toBe(false)
    })

    it('gemini profiles have native vision and mandatory thinking', () => {
      const gemini = MODEL_PROFILES['gemini-3.5-flash']
      expect(gemini.supportsAttachments).toBe(true)
      expect(gemini.thinkingMandatory).toBe(true)
      // Gemini não fala enable_thinking — nada de params de outros dialetos.
      expect(gemini.thinkingParam).toBeNull()
    })

    it('qwen3.7-max-2026-06-08 has native vision and search', () => {
      const qwen = MODEL_PROFILES['qwen3.7-max-2026-06-08']
      expect(qwen.modelId).toBe('qwen3.7-max-2026-06-08')
      expect(qwen.supportsAttachments).toBe(true)
      expect(qwen.supportsSearch).toBe(true)
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
    it('returns all 6 profiles (aliases deduped)', () => {
      const all = getAllModelProfiles()
      expect(all.length).toBe(6)
      expect(all.filter(p => p.id.startsWith('qwen3.7-max')).length).toBe(1)
      expect(all.filter(p => p.id.startsWith('gemini-')).length).toBe(2)
    })
  })

  describe('buildThinkingParam', () => {
    it('emits the `thinking: { type }` object for the GLM-5.2 shape', () => {
      const glm = MODEL_PROFILES['glm-5.2']
      expect(buildThinkingParam(glm, true)).toEqual({ thinking: { type: 'enabled' } })
      expect(buildThinkingParam(glm, false)).toEqual({ thinking: { type: 'disabled' } })
    })

    it('emits enable_thinking for the MiMo/DashScope shape', () => {
      const mimo = MODEL_PROFILES['mimo-v2.5-pro-1m']
      expect(buildThinkingParam(mimo, true)).toEqual({
        enable_thinking: true,
        max_thinking_tokens: 8192,
      })
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
