import {
  getModelProfile,
  getProfileForPlan,
  MODEL_PROFILES,
  DEFAULT_MODEL_ID,
} from '../modelProfiles'

// Swap de catálogo 2026-08-04: DeepSeek V4 Pro, MiMo V2.5 base e Qwen 3.7 Max
// saíram (o MiMo V2.5 PRO mantém-se, e continua o default); entrou qwen3.8-max;
// Grok 4.5 e Kimi K3 ganharam aliases author/model do Cloudflare AI Gateway.
describe('modelProfiles', () => {
  describe('MODEL_PROFILES registry', () => {
    it('contains the expected model + alias keys', () => {
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).toContain('glm-5.2')
      // DashScope (US) pode reportar o id base 'glm-5' — alias para o MESMO
      // perfil do glm-5.2, senão o lookup cai no default ao rotear por DashScope.
      expect(ids).toContain('glm-5')
      expect(MODEL_PROFILES['glm-5']).toBe(MODEL_PROFILES['glm-5.2'])
      expect(ids).toContain('qwen3.8-max')
      // Grok 4.5 + aliases (incl. o id author/model do Cloudflare AI Gateway).
      expect(ids).toContain('grok-4.5')
      expect(MODEL_PROFILES['xai/grok-4.5']).toBe(MODEL_PROFILES['grok-4.5'])
      expect(MODEL_PROFILES['grok-4.5-latest']).toBe(MODEL_PROFILES['grok-4.5'])
      expect(MODEL_PROFILES['grok-build-latest']).toBe(MODEL_PROFILES['grok-4.5'])
      // Kimi K3 — Moonshot directo e via Cloudflare AI Gateway.
      expect(ids).toContain('kimi-k3')
      expect(MODEL_PROFILES['moonshotai/kimi-k3']).toBe(MODEL_PROFILES['kimi-k3'])
    })

    it('removed models (swap 2026-08-04) are gone from the registry', () => {
      const ids = Object.keys(MODEL_PROFILES)
      expect(ids).not.toContain('deepseek-v4-pro')
      expect(ids).not.toContain('qwen3.7-max-2026-06-08')
      expect(ids).not.toContain('qwen3.7-max')
      expect(ids).not.toContain('mimo-v2.5-1m')
      // O Pro fica.
      expect(ids).toContain('mimo-v2.5-pro-1m')
    })

    it('mimo-v2.5-pro-1m has correct specs', () => {
      const mimo = MODEL_PROFILES['mimo-v2.5-pro-1m']
      expect(mimo.thinkingMode).toBe('toggleable')
      expect(mimo.supportsThinking).toBe(true)
      expect(mimo.contextWindow).toBe(1_048_576)
      expect(mimo.maxOutputTokens).toBe(32_768)
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

    it('grok-4.5 is capped at 200K context (cost tier) with mandatory thinking', () => {
      const grok = MODEL_PROFILES['grok-4.5']
      expect(grok.modelId).toBe('grok-4.5')
      // Janela capada em 200K — tier de preço barato do provider ($2/$0.30/$6;
      // ≥200k salta para $4/$0.60/$12), presumido repassado pelo gateway.
      expect(grok.contextWindow).toBe(200_000)
      expect(grok.thinkingMandatory).toBe(true)
      expect(grok.supportsAttachments).toBe(true)
    })

    it('qwen3.8-max has native vision and search, hybrid thinking, 131K output', () => {
      const qwen = MODEL_PROFILES['qwen3.8-max']
      expect(qwen.modelId).toBe('qwen3.8-max')
      expect(qwen.contextWindow).toBe(1_000_000)
      expect(qwen.maxOutputTokens).toBe(131_072)
      expect(qwen.thinkingMode).toBe('toggleable')
      expect(qwen.supportsAttachments).toBe(true)
      expect(qwen.supportsSearch).toBe(true)
    })

    it('kimi-k3 has 1M context and mandatory (always-on) thinking', () => {
      const kimi = MODEL_PROFILES['kimi-k3']
      expect(kimi.modelId).toBe('kimi-k3')
      expect(kimi.contextWindow).toBe(1_048_576)
      expect(kimi.thinkingMode).toBe('mandatory')
      expect(kimi.thinkingMandatory).toBe(true)
      expect(kimi.supportsThinking).toBe(true)
    })
  })

  describe('getModelProfile', () => {
    it('falls back to default model for unknown ID', () => {
      const profile = getModelProfile('nonexistent-model')
      expect(profile.id).toBe(DEFAULT_MODEL_ID)
    })

    it('default continua a ser o MiMo V2.5 Pro (mantido no swap 2026-08-04)', () => {
      expect(DEFAULT_MODEL_ID).toBe('mimo-v2.5-pro-1m')
    })
  })

  describe('getProfileForPlan', () => {
    it('always returns the default profile regardless of plan', () => {
      expect(getProfileForPlan('explorer').id).toBe(DEFAULT_MODEL_ID)
      expect(getProfileForPlan('vibe').id).toBe(DEFAULT_MODEL_ID)
      expect(getProfileForPlan('pro').id).toBe(DEFAULT_MODEL_ID)
      expect(getProfileForPlan('max').id).toBe(DEFAULT_MODEL_ID)
      expect(getProfileForPlan('welcome').id).toBe(DEFAULT_MODEL_ID)
    })

    it('returned profile has toggleable thinking and 1M context', () => {
      const profile = getProfileForPlan('pro')
      expect(profile.thinkingMode).toBe('toggleable')
      expect(profile.supportsThinking).toBe(true)
      expect(profile.contextWindow).toBe(1_048_576)
    })
  })
})
