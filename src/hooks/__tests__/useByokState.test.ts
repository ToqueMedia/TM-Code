/**
 * Pins the `byokConfigured` rule that previously existed inline in 5
 * sites and drifted. Tests target the pure function `computeByokConfigured`
 * to keep the assertions independent of Zustand / React / Firebase
 * runtime — the hook + snapshot variants are thin wrappers that read
 * the relevant store fields and delegate to this function.
 */
import { computeByokConfigured } from '../byokConfigured'

describe('computeByokConfigured', () => {
  it('returns false when nothing is set', () => {
    expect(
      computeByokConfigured({
        sessionSnapshot: null,
        enabled: false,
        activeProvider: null,
        activeModel: null,
      }),
    ).toBe(false)
  })

  describe('session snapshot path', () => {
    it('any non-null session snapshot configures BYOK', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: { providerId: 'anthropic', modelId: 'claude-opus' },
          enabled: false,
          activeProvider: null,
          activeModel: null,
        }),
      ).toBe(true)
    })

    it('session snapshot wins even when global store is empty', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: { providerId: 'x', modelId: 'y' },
          enabled: false,
          activeProvider: null,
          activeModel: null,
        }),
      ).toBe(true)
    })
  })

  describe('global store path — all three required', () => {
    it('enabled alone is not enough', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: null,
          enabled: true,
          activeProvider: null,
          activeModel: null,
        }),
      ).toBe(false)
    })

    it('enabled + provider without model is not enough', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: null,
          enabled: true,
          activeProvider: 'openai',
          activeModel: null,
        }),
      ).toBe(false)
    })

    it('enabled + provider + model = configured', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: null,
          enabled: true,
          activeProvider: 'openai',
          activeModel: 'gpt-4',
        }),
      ).toBe(true)
    })

    it('enabled=false blocks even with full provider+model', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: null,
          enabled: false,
          activeProvider: 'openai',
          activeModel: 'gpt-4',
        }),
      ).toBe(false)
    })
  })

  describe('disjunction', () => {
    it('session snapshot OR global selection — either is sufficient', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: { providerId: 'a', modelId: 'b' },
          enabled: false,
          activeProvider: null,
          activeModel: null,
        }),
      ).toBe(true)

      expect(
        computeByokConfigured({
          sessionSnapshot: null,
          enabled: true,
          activeProvider: 'a',
          activeModel: 'b',
        }),
      ).toBe(true)
    })

    it('neither path satisfied → false', () => {
      expect(
        computeByokConfigured({
          sessionSnapshot: null,
          enabled: true,
          activeProvider: null,
          activeModel: 'b',
        }),
      ).toBe(false)
    })
  })
})
