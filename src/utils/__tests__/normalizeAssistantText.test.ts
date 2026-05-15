import { normalizeAssistantText } from '../normalizeAssistantText'

describe('normalizeAssistantText', () => {
  // ── empty / no-op cases ─────────────────────────────────────
  it('returns empty for empty input', () => {
    expect(normalizeAssistantText('')).toBe('')
  })

  it('preserves already-correctly-formatted text', () => {
    const text = 'First sentence.\n\nSecond sentence.'
    expect(normalizeAssistantText(text)).toBe(text)
  })

  it('does not split mid-sentence (lowercase after period)', () => {
    expect(normalizeAssistantText('end.start of next')).toBe('end.start of next')
  })

  // ── the BugHunterKimi cases ─────────────────────────────────
  it('splits ".O" sentence boundary (Vou corrigir isso agora.O ReportBug)', () => {
    const r = normalizeAssistantText('Vou corrigir isso agora.O ReportBug.tsx está')
    expect(r).toBe('Vou corrigir isso agora.\n\nO ReportBug.tsx está')
  })

  it('splits ":P" colon boundary (API:Preciso)', () => {
    const r = normalizeAssistantText('através da API:Preciso de adicionar')
    expect(r).toBe('através da API:\n\nPreciso de adicionar')
  })

  it('splits ":O" colon boundary (em falta:O código)', () => {
    const r = normalizeAssistantText('que está em falta:O código está correto')
    expect(r).toBe('que está em falta:\n\nO código está correto')
  })

  it('handles the full BugHunterKimi line end-to-end', () => {
    const input =
      'Tens razão! A lógica do agente está no frontend em vez de usar o Mercury 2 no backend. ' +
      'Vou corrigir isso agora.O ReportBug.tsx está a usar lógica local em vez de chamar o backend. ' +
      'Vou corrigir para usar o Mercury 2 através da API:Preciso de adicionar a função ' +
      'startChatSession ao bugStore que está em falta:O código está correto mas preciso de verificar'
    const r = normalizeAssistantText(input)
    expect(r).toContain('agora.\n\nO ReportBug')
    expect(r).toContain('API:\n\nPreciso')
    expect(r).toContain('falta:\n\nO código')
  })

  // ── false-positive guards ───────────────────────────────────
  it('does NOT split inside acronyms (U.S.A.Today — UPPER before .)', () => {
    // Conservative: "U.S" is not split because the char before the period is
    // uppercase. "S.A.Today" — char before second period is 'S' uppercase →
    // no split. Same for third. The last segment "A.Today" — char before
    // period is 'A' (uppercase) → not split. So the whole acronym stays.
    const r = normalizeAssistantText('U.S.A.Today reports')
    expect(r).toBe('U.S.A.Today reports')
  })

  it('does NOT split JSON.parse (Upper letter after dot but lowercase next)', () => {
    expect(normalizeAssistantText('use JSON.parse to deserialize')).toBe('use JSON.parse to deserialize')
  })

  it('does NOT split inside fenced code blocks', () => {
    const input = 'Look at this:\n```\nfoo.Bar()\nbaz:Qux\n```\nAfter.End'
    const r = normalizeAssistantText(input)
    expect(r).toContain('foo.Bar()')  // unchanged inside ``` ```
    expect(r).toContain('baz:Qux')    // unchanged inside ``` ```
    expect(r).toContain('After.\n\nEnd')  // split in prose
  })

  it('does NOT split inside inline code', () => {
    const input = 'The function `foo.Bar()` returns a value.End'
    const r = normalizeAssistantText(input)
    expect(r).toContain('`foo.Bar()`')  // inline code preserved
    expect(r).toContain('value.\n\nEnd')  // split in prose
  })

  // ── idempotency ─────────────────────────────────────────────
  it('is idempotent (running twice yields the same result)', () => {
    const input = 'one.Two:Three end.'
    const once = normalizeAssistantText(input)
    const twice = normalizeAssistantText(once)
    expect(twice).toBe(once)
  })

  // ── exclamation + question ──────────────────────────────────
  it('splits "!" + UPPER', () => {
    expect(normalizeAssistantText('Corrigido!Agora vou testar')).toBe('Corrigido!\n\nAgora vou testar')
  })

  it('splits "?" + UPPER', () => {
    expect(normalizeAssistantText('Faz sentido?Vamos avançar')).toBe('Faz sentido?\n\nVamos avançar')
  })

  // ── Portuguese / Spanish capitals ──────────────────────────
  it('splits with accented capitals (Á, É, ...)', () => {
    expect(normalizeAssistantText('teste.Ágora bora')).toBe('teste.\n\nÁgora bora')
  })
})
