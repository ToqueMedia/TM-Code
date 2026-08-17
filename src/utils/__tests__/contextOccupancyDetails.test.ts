import {
  buildContextOccupancyDetails,
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
} from '../contextWindow'

/**
 * Números da sessão glm-5.2 / 262 144 (export 2026-08-14). O hover antigo
 * mostrava `ocupação / janela bruta` e uma % calculada na janela útil —
 * dois denominadores. Estes testes fixam o contrato único.
 */
describe('buildContextOccupancyDetails', () => {
  const WINDOW = 262_144

  it('usa a janela útil como denominador, não a bruta', () => {
    const d = buildContextOccupancyDetails({
      promptTokens: 85_033,
      responseTokens: 1_428,
      peakTokens: 90_967,
      rawWindow: WINDOW,
    })
    expect(d.rawWindow).toBe(WINDOW)
    expect(d.effective).toBe(getEffectiveContextWindowSize(WINDOW, null))
    expect(d.effective).toBe(242_144)
    expect(d.reserved).toBe(20_000)
    expect(d.threshold).toBe(getAutoCompactThreshold(WINDOW, null))
    expect(d.threshold).toBe(229_144)
    expect(d.used).toBe(86_461)
    expect(d.usedPct).toBe(36)
    expect(d.free).toBe(155_683)
    expect(d.untilCompact).toBe(142_683)
    expect(d.atThreshold).toBe(false)
    expect(d.hasUsage).toBe(true)
    expect(d.prompt).toBe(85_033)
    expect(d.response).toBe(1_428)
    expect(d.peak).toBe(90_967)
  })

  it('sessão vazia não finge 0% de uma conversa', () => {
    const d = buildContextOccupancyDetails({
      promptTokens: 0,
      responseTokens: 0,
      peakTokens: 0,
      rawWindow: WINDOW,
    })
    expect(d.hasUsage).toBe(false)
    expect(d.used).toBe(0)
    expect(d.usedPct).toBe(0)
    expect(d.free).toBe(242_144)
    expect(d.atThreshold).toBe(false)
  })

  it('145 608 reais numa janela de 262k não passam o limiar (screenshot 14-49-57)', () => {
    const d = buildContextOccupancyDetails({
      promptTokens: 145_608,
      responseTokens: 255,
      peakTokens: 145_608,
      rawWindow: WINDOW,
    })
    expect(d.used).toBe(145_863)
    expect(d.atThreshold).toBe(false)
    expect(d.usedPct).toBe(60)
    expect(d.untilCompact).toBe(229_144 - 145_863)
    expect(d.free).toBe(242_144 - 145_863)
  })

  it('no limiar: untilCompact = 0 e atThreshold', () => {
    const threshold = getAutoCompactThreshold(WINDOW, null)
    const d = buildContextOccupancyDetails({
      promptTokens: threshold,
      responseTokens: 0,
      peakTokens: threshold,
      rawWindow: WINDOW,
    })
    expect(d.atThreshold).toBe(true)
    expect(d.untilCompact).toBe(0)
    expect(d.hasUsage).toBe(true)
  })
})
