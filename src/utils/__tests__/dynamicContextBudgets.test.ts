/**
 * Os orçamentos de contexto seguem a JANELA ATIVA (2026-07-31).
 *
 * A janela real é publicada pelo admin por modelo (X-Model-Context-Window) e
 * pode ser 128K, 200K, 512K, 1M ou 2M. O limiar de auto-compactação, o aviso e
 * o limite de bloqueio já a respeitavam; o orçamento de tool results e o teto do
 * bloco de recuperação eram constantes fixas — as duas últimas peças da gestão
 * de contexto que não sabiam qual era o modelo.
 *
 * Um número fixo significa coisas opostas nos dois extremos: 40K de tool results
 * são 4% de uma janela de 1M (destruir o working set com 950K vazios ao lado, e
 * o modelo a reler o que já tinha) e 31% de uma de 128K (auto-compactação a
 * disparar muito antes do necessário).
 */
import {
  getToolResultBudgetTokens,
  getPostCompactRecoveryMaxChars,
  getEffectiveContextWindowSize,
  TOOL_RESULT_BUDGET_MAX,
  TOOL_RESULT_BUDGET_PCT,
} from '../contextWindow'

const WINDOWS = [128_000, 200_000, 256_000, 512_000, 1_000_000, 2_000_000]

describe('getToolResultBudgetTokens', () => {
  it('cresce com a janela — nunca devolve o mesmo para 128K e para 1M', () => {
    const small = getToolResultBudgetTokens(128_000)
    const large = getToolResultBudgetTokens(1_000_000)
    expect(large).toBeGreaterThan(small * 3)
  })

  it('é monótono na janela', () => {
    const values = WINDOWS.map(w => getToolResultBudgetTokens(w))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
    }
  })

  it('mantém-se uma fração sã da janela efetiva em todos os tamanhos', () => {
    for (const w of WINDOWS) {
      const effective = getEffectiveContextWindowSize(w)
      const budget = getToolResultBudgetTokens(w)
      // Nunca pode engolir a janela: sobra tem de haver para system prompt,
      // schemas de tools e a conversa em si.
      expect(budget).toBeLessThanOrEqual(effective * TOOL_RESULT_BUDGET_PCT + 1)
      expect(budget).toBeLessThan(effective / 2)
    }
  })

  it('trava no teto absoluto em janelas enormes', () => {
    expect(getToolResultBudgetTokens(2_000_000)).toBe(TOOL_RESULT_BUDGET_MAX)
  })

  it('numa janela pequena dá uma fatia proporcional, não um piso fixo', () => {
    // Um piso em tokens absolutos sobre-alocaria exatamente onde o espaço é
    // mais escasso — 40K numa janela de 64K seria a conversa inteira.
    const budget = getToolResultBudgetTokens(64_000)
    expect(budget).toBeLessThan(getEffectiveContextWindowSize(64_000) / 2)
    expect(budget).toBeGreaterThan(0)
  })

  it('janela inválida devolve 0 (o caller cai no valor por omissão)', () => {
    expect(getToolResultBudgetTokens(0)).toBe(0)
  })
})

describe('getPostCompactRecoveryMaxChars', () => {
  it('acompanha a janela', () => {
    expect(getPostCompactRecoveryMaxChars(1_000_000)).toBeGreaterThan(
      getPostCompactRecoveryMaxChars(128_000) * 3,
    )
  })

  it('nunca reinjeta uma fatia que volte a disparar a compactação', () => {
    for (const w of WINDOWS) {
      const effective = getEffectiveContextWindowSize(w)
      // O bloco entra logo a seguir a uma compactação; se sozinho valesse uma
      // fatia grande da janela, o turno seguinte compactava outra vez.
      const approxTokens = getPostCompactRecoveryMaxChars(w) / 4
      expect(approxTokens).toBeLessThanOrEqual(effective * 0.1)
    }
  })

  it('janela inválida devolve 0', () => {
    expect(getPostCompactRecoveryMaxChars(0)).toBe(0)
  })
})
