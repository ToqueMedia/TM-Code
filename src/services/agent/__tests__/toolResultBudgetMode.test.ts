/**
 * Os três braços do orçamento de tool results (docs/PLAN-CONTEXT-BUDGET.md).
 *
 * O que estes testes fixam NÃO é qual o braço melhor — isso mede-se com
 * `yarn evals:agent --only context-loss-rereads`, n ≥ 10, e ainda não está
 * medido. O que fixam são as propriedades de SEGURANÇA do instrumento, porque
 * um instrumento que mente é pior do que não ter instrumento:
 *
 *  1. o defeito é `always` — o comportamento que está em produção;
 *  2. um override mal escrito NUNCA desliga o orçamento (o prompt ficaria sem
 *     tecto nenhum);
 *  3. sem sinal de pressão, `trigger` comporta-se como `always` — a incerteza
 *     inclina para aparar, porque o custo de aparar de mais é uma releitura e o
 *     de aparar de menos é estourar a janela.
 */
jest.mock('../../../utils/viteEnv')

describe('braço do orçamento de tool results', () => {
  const load = (mode?: string, triggerPct?: string) => {
    jest.resetModules()
    jest.doMock('../../../utils/viteEnv', () => ({
      ...jest.requireActual<Record<string, unknown>>('../../../utils/__mocks__/viteEnv'),
      VITE_TOOL_RESULT_BUDGET_MODE: mode,
      VITE_TOOL_RESULT_BUDGET_TRIGGER_PCT: triggerPct,
    }))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../toolResultGlobalBudget') as typeof import('../toolResultGlobalBudget')
  }

  describe('resolveToolResultBudgetMode', () => {
    // DEFEITO `off` desde 2026-08-07: não se microcompacta. Com janelas de 1M
    // o tecto (250K) nunca é atingido por trabalho normal, e aparar a cada
    // pedido só parte a cache. A válvula é a auto-compactação.
    it('sem env, NÃO se microcompacta', () => {
      expect(load(undefined).resolveToolResultBudgetMode()).toBe('off')
    })

    it.each(['always', 'trigger', 'off'])('aceita %s', (m) => {
      expect(load(m).resolveToolResultBudgetMode()).toBe(m)
    })

    it('tolera espaços e maiúsculas (vem de uma linha de shell)', () => {
      expect(load('  TRIGGER ').resolveToolResultBudgetMode()).toBe('trigger')
    })

    // Um valor errado cai no defeito documentado, nunca num braço ao calhas —
    // em particular, nunca liga o aparo sem quem o peça.
    it.each(['', 'nenhum', 'false', '0', 'disabled'])(
      'valor desconhecido (%s) cai no defeito',
      (v) => {
        const mod = load(v)
        expect(mod.resolveToolResultBudgetMode()).toBe(mod.DEFAULT_TOOL_RESULT_BUDGET_MODE)
      },
    )
  })

  describe('resolveToolResultBudgetTriggerRatio', () => {
    it('sem override, é a razão por defeito', () => {
      const mod = load('trigger')
      expect(mod.resolveToolResultBudgetTriggerRatio()).toBe(
        mod.TOOL_RESULT_BUDGET_TRIGGER_RATIO,
      )
    })

    it('converte a percentagem em fracção', () => {
      expect(load('trigger', '50').resolveToolResultBudgetTriggerRatio()).toBe(0.5)
    })

    it.each(['0', '-10', '101', 'abc', ''])('valor inválido (%s) é ignorado', (v) => {
      const mod = load('trigger', v)
      expect(mod.resolveToolResultBudgetTriggerRatio()).toBe(
        mod.TOOL_RESULT_BUDGET_TRIGGER_RATIO,
      )
    })
  })

  // O override de RUNTIME (knobs do runner) manda sobre a env de BUILD. É esta
  // precedência que permite correr braços diferentes com um vite partilhado —
  // sem ela, 12 corridas mediram a mesma célula a 2026-08-07.
  describe('override de runtime (knobs)', () => {
    it('manda sobre a env de build', () => {
      const mod = load('always')            // env de build diz `always`
      expect(mod.resolveToolResultBudgetMode()).toBe('always')
      mod.setToolResultBudgetOverrides({ mode: 'trigger' })
      expect(mod.resolveToolResultBudgetMode()).toBe('trigger')
      mod.clearToolResultBudgetOverrides()
      expect(mod.resolveToolResultBudgetMode()).toBe('always')
    })

    it('a razão do gatilho também', () => {
      const mod = load('trigger', '50')
      expect(mod.resolveToolResultBudgetTriggerRatio()).toBe(0.5)
      mod.setToolResultBudgetOverrides({ triggerPct: '95' })
      expect(mod.resolveToolResultBudgetTriggerRatio()).toBe(0.95)
    })

    // Mesma propriedade de segurança do lado da env: lixo não desliga nada.
    it.each(['', 'nenhum', 'off ligado', '0'])(
      'knob inválido (%s) não muda o braço activo',
      (v) => {
        const mod = load('trigger')
        mod.setToolResultBudgetOverrides({ mode: v })
        expect(mod.resolveToolResultBudgetMode()).toBe('trigger')
      },
    )

    it.each(['0', '-1', '101', 'abc'])('pct inválido (%s) é ignorado', (v) => {
      const mod = load('trigger')
      mod.setToolResultBudgetOverrides({ triggerPct: v })
      expect(mod.resolveToolResultBudgetTriggerRatio()).toBe(
        mod.TOOL_RESULT_BUDGET_TRIGGER_RATIO,
      )
    })

    it('knobs ausentes deixam a env de build a decidir', () => {
      const mod = load('off')
      mod.setToolResultBudgetOverrides({})
      expect(mod.resolveToolResultBudgetMode()).toBe('off')
    })
  })

  describe('shouldApplyToolResultBudget', () => {
    const { shouldApplyToolResultBudget } = load(undefined)

    it('`always` aplica sempre, mesmo com a janela vazia', () => {
      expect(
        shouldApplyToolResultBudget({
          mode: 'always',
          occupancyTokens: 1,
          autoCompactThreshold: 1_000_000,
        }),
      ).toBe(true)
    })

    it('`off` nunca aplica, mesmo em cima do limiar', () => {
      expect(
        shouldApplyToolResultBudget({
          mode: 'off',
          occupancyTokens: 999_999,
          autoCompactThreshold: 100_000,
        }),
      ).toBe(false)
    })

    it('`trigger` deixa passar longe do limiar — é isto que evita as releituras', () => {
      expect(
        shouldApplyToolResultBudget({
          mode: 'trigger',
          occupancyTokens: 30_000,
          autoCompactThreshold: 100_000,
          triggerRatio: 0.75,
        }),
      ).toBe(false)
    })

    it('`trigger` aplica ao chegar à fracção do limiar', () => {
      expect(
        shouldApplyToolResultBudget({
          mode: 'trigger',
          occupancyTokens: 75_000,
          autoCompactThreshold: 100_000,
          triggerRatio: 0.75,
        }),
      ).toBe(true)
    })

    // O ponto do braço C: acordar ANTES da compactação, não ao mesmo tempo.
    it('`trigger` acorda antes do limiar de compactação, não em cima dele', () => {
      const threshold = 100_000
      const justBelow = threshold - 1
      expect(
        shouldApplyToolResultBudget({
          mode: 'trigger',
          occupancyTokens: justBelow,
          autoCompactThreshold: threshold,
        }),
      ).toBe(true)
    })

    it.each([
      ['sem ocupação', { occupancyTokens: null, autoCompactThreshold: 100_000 }],
      ['ocupação zero', { occupancyTokens: 0, autoCompactThreshold: 100_000 }],
      ['sem limiar', { occupancyTokens: 50_000, autoCompactThreshold: null }],
      ['limiar zero', { occupancyTokens: 50_000, autoCompactThreshold: 0 }],
    ])('%s → `trigger` comporta-se como `always`', (_label, args) => {
      expect(shouldApplyToolResultBudget({ mode: 'trigger', ...args })).toBe(true)
    })
  })
})
