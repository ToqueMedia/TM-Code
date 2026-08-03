/**
 * `/context` — a superfície que faltava para telemetria que já existia.
 *
 * O payloadInspector escreve a repartição por categoria, as maiores secções do
 * system prompt e os números de cache em `session.requestUsageLog` desde sempre.
 * Nada disso tinha UI: a pílula de pressão diz "quanto falta" e nunca "porquê",
 * que é a única pergunta acionável numa sessão longa.
 *
 * As percentagens têm de usar o MESMO denominador que a pílula e o limiar de
 * auto-compactação (a janela efetiva) — três números sobre a mesma coisa que se
 * contradizem são piores do que nenhum.
 */
const agentState = {
  modelContextWindow: 200_000 as number | null,
  modelMaxOutputTokens: 32_000 as number | null,
  modelName: 'modelo-de-teste',
}

jest.mock('../../../stores/agentStore', () => ({
  useAgentStore: { getState: () => agentState },
}))
jest.mock('../../../stores/billingStore', () => ({
  useBillingStore: { getState: () => ({ plan: 'pro' }) },
}))
jest.mock('../../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ getActiveSession: () => null, addSystemMessage: jest.fn() }) },
}))
jest.mock('../modelProfiles', () => ({
  MODEL_PROFILES: {} as Record<string, unknown>,
  getProfileForPlan: () => ({ contextWindow: 200_000, maxOutputTokens: 32_000 }),
}))

import { renderContextReport } from '../commands/contextCommand'
import type { RequestUsageEntry } from '../../../types/chat'

const entry = (over: Partial<RequestUsageEntry> = {}): RequestUsageEntry =>
  ({
    requestId: 'r1',
    turn: 4,
    model: 'modelo-de-teste',
    inputTokens: 90_000,
    outputTokens: 1_200,
    estimatedInputTokens: 88_000,
    breakdown: {
      system: { blocks: 1, tokens: 20_000, chars: 60_000 },
      tool_result: { blocks: 12, tokens: 50_000, chars: 150_000 },
      text: { blocks: 8, tokens: 5_000, chars: 15_000 },
    },
    ...over,
  }) as RequestUsageEntry

beforeEach(() => {
  agentState.modelContextWindow = 200_000
  agentState.modelMaxOutputTokens = 32_000
})

describe('renderContextReport', () => {
  it('mostra a ocupação sobre a janela EFETIVA, não a bruta', () => {
    const out = renderContextReport(entry())
    // 90k sobre 180k efetivos = 50%. Sobre 200k brutos daria 45% e
    // contradiria a pílula.
    expect(out).toContain('50%')
    expect(out).toContain('180.0k')
  })

  it('ordena as categorias pela que mais ocupa', () => {
    const out = renderContextReport(entry())
    expect(out.indexOf('Resultados de tools')).toBeLessThan(out.indexOf('System prompt'))
    expect(out.indexOf('System prompt')).toBeLessThan(out.indexOf('Conversa (texto)'))
  })

  it('inclui os schemas de tools, que não vêm no breakdown das mensagens', () => {
    // Os schemas viajam no campo `tools` do pedido, não nas mensagens — ficavam
    // invisíveis num mapa construído só a partir do breakdown.
    const out = renderContextReport(entry({ toolDefsTokens: 9_000, toolCount: 20, toolCountTotal: 43 }))
    expect(out).toContain('Schemas de tools (20 de 43)')
    expect(out).toContain('9.0k')
  })

  it('situa os tool results face ao orçamento, que segue a janela', () => {
    const out = renderContextReport(entry())
    // 30% de 180k efetivos = 54k.
    expect(out).toMatch(/50\.0k \/ 54\.0k/)
  })

  it('o orçamento acompanha a janela — 1M não mostra o mesmo teto que 200K', () => {
    const at200k = renderContextReport(entry())
    agentState.modelContextWindow = 1_000_000
    const at1m = renderContextReport(entry())
    expect(at200k).not.toEqual(at1m)
    expect(at1m).toContain('1.00M')
  })

  it('separa secções cacheáveis das reconstruídas por turno', () => {
    // É essa a distinção acionável: uma secção `por turno` paga preço cheio
    // em todos os pedidos.
    const out = renderContextReport(entry({
      systemPromptSections: [
        { name: 'project_structure', location: 'static', tokens: 8_000, chars: 24_000 },
        { name: 'git_status', location: 'dynamic', tokens: 1_500, chars: 4_500 },
      ],
    }))
    expect(out).toContain('project_structure')
    expect(out).toContain('cacheável')
    expect(out).toContain('por turno')
  })

  it('diz quando os números são estimativa, em vez de os apresentar como reais', () => {
    const out = renderContextReport(entry({ usageAvailable: false }))
    expect(out).toContain('estimativa do inspector')
  })

  it('omite a secção de cache quando o provider não reporta nada', () => {
    expect(renderContextReport(entry())).not.toContain('Cache de prefixo')
  })

  it('mostra a percentagem vinda de cache quando há números', () => {
    const out = renderContextReport(entry({ cacheReadInputTokens: 60_000, cacheCreationInputTokens: 0, inputTokens: 20_000 }))
    expect(out).toContain('Cache de prefixo')
    expect(out).toContain('75%')
  })

  it('reporta COMO a ocupação foi decidida — um run em max-fallback está a decidir só com o estimador', () => {
    expect(renderContextReport(entry({ occupancySource: 'anchored' }))).toContain('ancorada')
    expect(renderContextReport(entry({ occupancySource: 'max-fallback' }))).toContain('fallback')
  })
})
