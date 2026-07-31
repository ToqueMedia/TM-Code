/**
 * Regression tests for the real-window auto-compact decision (context
 * pollution audit, 2026-06-12). Before this, shouldAutoCompact hardcoded a 1M
 * window and a char-estimate, so a small-window model could overflow without
 * ever compacting. Now it tracks the active model's real window and the
 * provider's real token occupancy.
 */
import { shouldAutoCompact, resolveOccupancyWithSource, type AutoCompactLimits } from '../autoCompact'
import { CHARS_PER_TOKEN_ESTIMATE } from '../../agentConfig'
import { getAutoCompactThreshold } from '../../../../utils/contextWindow'

// Uma mensagem cuja ESTIMATIVA é ~`tokens`. O divisor deixou de ser 3 fixo:
// é CHARS_PER_TOKEN_ESTIMATE, medido contra os `usage` reais do provider.
// O helper deriva dele para não voltar a ficar dessincronizado em silêncio.
function msgOfTokens(tokens: number) {
  return { role: 'user' as const, content: 'x'.repeat(Math.round(tokens * CHARS_PER_TOKEN_ESTIMATE)) }
}

describe('shouldAutoCompact — real window limits', () => {
  it('fires well before overflow on a small (200K) window that a 1M window would tolerate', () => {
    // 180K tokens of history (real threshold for a 200K window ≈ 167K).
    const messages = [msgOfTokens(180_000)]
    const limits: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }

    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
    // Sanity: a real 1M window has ample room at 180K → no compaction. (The
    // window genuinely drives the decision; it is no longer a fixed 1M.)
    expect(shouldAutoCompact(messages, 0, { contextWindow: 1_000_000, maxOutputTokens: 65_536 })).toBe(false)
  })

  it('does not fire when occupancy is comfortably under the real threshold', () => {
    const messages = [msgOfTokens(50_000)]
    const limits: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(false)
  })

  it('uses the provider real occupancy when it exceeds the char-estimate (catches tool_call args the estimate misses)', () => {
    // Tiny text estimate, but the provider counted 190K real tokens.
    const messages = [msgOfTokens(1_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      realOccupancyTokens: 190_000,
    }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
  })

  it('uses the char-estimate when it exceeds the real occupancy (tool results appended since last turn)', () => {
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    const messages = [msgOfTokens(threshold + 5_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      // last turn's real reading was small; estimate must still win
      realOccupancyTokens: 10_000,
    }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
  })

  // ── Âncora no real + delta (2026-07-31) ────────────────────────────────
  //
  // O estimador é ceil(chars/3): assume 3 caracteres por token onde a
  // convenção é 4, logo é ~33% alto POR CONSTRUÇÃO. Medido contra o provider
  // em duas sessões reais: 1,39x. Enquanto os dois se combinavam por
  // `Math.max`, o real NUNCA podia baixar a conta e a compactação disparava
  // ~30% cedo — o modelo perdia conversa com um terço da janela ainda livre.

  it('honra o real quando o estimador está inflacionado, em vez de deixar o maior ganhar', () => {
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    // Uma só mensagem cuja ESTIMATIVA fica acima do limiar, mas que o provider
    // contou bem abaixo — a diferença de 1,39x que medimos em produção.
    const realTokens = Math.round((threshold - 5_000) / 1.39)
    const messages = [msgOfTokens(threshold + 5_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      realOccupancyTokens: realTokens,
      realOccupancyMessageCount: 1,
    }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(false)

    // Sem a âncora, a mesma entrada compacta — é o comportamento antigo, e é
    // exactamente a compactação prematura que a âncora existe para evitar.
    expect(shouldAutoCompact(messages, 0, {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      realOccupancyTokens: realTokens,
    })).toBe(true)
  })

  it('soma ao real a estimativa DAS MENSAGENS NOVAS desde a medição', () => {
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    const anchored = threshold - 10_000
    // Mensagem 0 = o que o real já cobre (o seu tamanho não volta a contar).
    // Mensagem 1 = acrescentada depois; só esta passa pelo estimador.
    const messages = [msgOfTokens(500_000), msgOfTokens(20_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      realOccupancyTokens: anchored,
      realOccupancyMessageCount: 1,
    }
    // anchored + ~20K > threshold → dispara pelo DELTA, não pelo tamanho
    // absurdo da mensagem já contabilizada.
    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)

    const folgado: AutoCompactLimits = { ...limits, realOccupancyTokens: threshold - 40_000 }
    expect(shouldAutoCompact(messages, 0, folgado)).toBe(false)
  })

  it('cai no comportamento antigo quando a âncora não cobre o histórico atual', () => {
    // Uma compactação encolheu as mensagens abaixo do ponto medido: a âncora
    // deixou de ser válida e não se pode confiar nela para baixar a conta.
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    const messages = [msgOfTokens(threshold + 5_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      realOccupancyTokens: 10_000,
      realOccupancyMessageCount: 9,
    }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
  })

  it('subtracts snip-freed tokens from the estimate', () => {
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    const messages = [msgOfTokens(threshold + 5_000)]
    const limits: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }
    // Freeing 20K drops the estimate below threshold.
    expect(shouldAutoCompact(messages, 20_000, limits)).toBe(false)
  })

  it('uses the conservative fallback window when unknown (null) — no longer assumes 1M', () => {
    // Was the legacy-1M bug: a null window assumed ~967K and never compacted.
    // Now an unknown window assumes the conservative 200K fallback, so 170K
    // (above the ~167K threshold for 200K) DOES compact instead of overflowing.
    const limits: AutoCompactLimits = { contextWindow: null, maxOutputTokens: null }
    expect(shouldAutoCompact([msgOfTokens(170_000)], 0, limits)).toBe(true)
    // A comfortably small occupancy still does not compact under the fallback.
    expect(shouldAutoCompact([msgOfTokens(50_000)], 0, limits)).toBe(false)
  })

  it('threshold respects the real window: a 1M model tolerates far more than a 200K one', () => {
    const messages = [msgOfTokens(300_000)]
    expect(shouldAutoCompact(messages, 0, { contextWindow: 200_000, maxOutputTokens: 16_384 })).toBe(true)
    expect(shouldAutoCompact(messages, 0, { contextWindow: 1_000_000, maxOutputTokens: 65_536 })).toBe(false)
  })
})

describe('resolveOccupancyWithSource — a fonte é observável', () => {
  const base: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }

  it('diz `estimate-only` no primeiro turno (ainda não há real)', () => {
    const r = resolveOccupancyWithSource([msgOfTokens(1_000)], 0, base)
    expect(r.source).toBe('estimate-only')
  })

  it('diz `anchored` quando a âncora cobre o histórico', () => {
    const r = resolveOccupancyWithSource([msgOfTokens(1_000)], 0, {
      ...base, realOccupancyTokens: 50_000, realOccupancyMessageCount: 1,
    })
    expect(r.source).toBe('anchored')
    expect(r.tokens).toBe(50_000)
  })

  it('diz `max-fallback` quando a âncora já não cobre o histórico', () => {
    // Uma compactação encolheu as mensagens abaixo do ponto medido.
    const r = resolveOccupancyWithSource([msgOfTokens(1_000)], 0, {
      ...base, realOccupancyTokens: 50_000, realOccupancyMessageCount: 9,
    })
    expect(r.source).toBe('max-fallback')
    expect(r.tokens).toBe(50_000)
  })

  // `snipTokensFreed` é 0 hoje (o snip de rotina saiu do caminho por pedido),
  // mas o ramo ancorado subtrai-o de propósito: o snip liberta tokens da
  // região que o `real` já contabilizou. Sem este teste, a aritmética ficava
  // sem prova para o dia em que o snip voltar.
  it('subtrai snip-freed tokens TAMBÉM no ramo ancorado', () => {
    const limits = { ...base, realOccupancyTokens: 50_000, realOccupancyMessageCount: 1 }
    const semSnip = resolveOccupancyWithSource([msgOfTokens(1_000)], 0, limits)
    const comSnip = resolveOccupancyWithSource([msgOfTokens(1_000)], 8_000, limits)
    expect(semSnip.source).toBe('anchored')
    expect(comSnip.source).toBe('anchored')
    expect(semSnip.tokens - comSnip.tokens).toBe(8_000)
  })
})
