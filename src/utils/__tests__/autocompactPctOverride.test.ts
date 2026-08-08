/**
 * Override do limiar de auto-compactação (porte de
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, cli-vaz autoCompact.ts:79).
 *
 * Existe para TESTAR a compactação: sem ele, exercitá-la obriga a encher uma
 * janela inteira, e a única forma de a ver era uma sessão real de horas — foi
 * assim que passámos 2026-08-06 a descobrir defeitos de compactação por
 * exports do developer em vez de por evals.
 *
 * A propriedade que interessa é que o override SÓ ENCURTA: um valor mal posto
 * pode antecipar a compactação, nunca adiá-la.
 */
jest.mock('../viteEnv')

describe('VITE_AUTOCOMPACT_PCT', () => {
  const WINDOW = 131_072
  const MAX_OUT = 32_000

  const load = (pct?: string) => {
    jest.resetModules()
    jest.doMock('../viteEnv', () => ({
      ...jest.requireActual<Record<string, unknown>>('../__mocks__/viteEnv'),
      VITE_AUTOCOMPACT_PCT: pct,
    }))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../contextWindow') as typeof import('../contextWindow')
  }

  it('sem override, o limiar é o normal (janela efectiva menos o buffer)', () => {
    const { getAutoCompactThreshold, getEffectiveContextWindowSize } = load(undefined)
    const eff = getEffectiveContextWindowSize(WINDOW, MAX_OUT)
    const th = getAutoCompactThreshold(WINDOW, MAX_OUT)
    expect(th).toBeGreaterThan(0)
    expect(th).toBeLessThan(eff)
  })

  it('com override, dispara à percentagem pedida da janela efectiva', () => {
    const { getAutoCompactThreshold, getEffectiveContextWindowSize } = load('15')
    const eff = getEffectiveContextWindowSize(WINDOW, MAX_OUT)
    expect(getAutoCompactThreshold(WINDOW, MAX_OUT)).toBe(Math.floor(eff * 0.15))
  })

  // A propriedade de segurança: só encurta.
  it('um override ALTO não adia a compactação — o limiar normal ganha', () => {
    const semOverride = load(undefined).getAutoCompactThreshold(WINDOW, MAX_OUT)
    const com99 = load('99').getAutoCompactThreshold(WINDOW, MAX_OUT)
    expect(com99).toBe(semOverride)
  })

  it.each(['0', '-5', '101', 'abc', ''])('valor inválido (%s) é ignorado', (v) => {
    const semOverride = load(undefined).getAutoCompactThreshold(WINDOW, MAX_OUT)
    expect(load(v).getAutoCompactThreshold(WINDOW, MAX_OUT)).toBe(semOverride)
  })
})
