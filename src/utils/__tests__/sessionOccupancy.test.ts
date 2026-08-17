import {
  resolveSessionOccupancy,
  resolveQueryOccupancySeed,
  resolveSeedMessageCount,
} from '../sessionOccupancy'
import type { RequestUsageEntry } from '../../types/chat'

function usage(inputTokens: number, outputTokens = 0): RequestUsageEntry {
  return { inputTokens, outputTokens, usageAvailable: true } as RequestUsageEntry
}

describe('resolveSessionOccupancy — reabrir projecto trabalhado', () => {
  it('usa lastTurnSnapshot quando lastPromptTokens não veio no JSON (zAi)', () => {
    const occ = resolveSessionOccupancy({
      lastTurnSnapshot: {
        promptTokens: 128_613,
        responseTokens: 0,
        contextWindow: null,
        modelName: null,
      },
      messages: [{ content: 'hello', kind: undefined }],
    })
    expect(occ.source).toBe('lastTurnSnapshot')
    expect(occ.promptTokens).toBe(128_613)
    expect(occ.peakTokens).toBe(128_613)
  })

  it('com log real, o snapshot cede — o último pedido no fio manda', () => {
    const occ = resolveSessionOccupancy({
      lastTurnSnapshot: {
        promptTokens: 128_613,
        responseTokens: 0,
        contextWindow: null,
        modelName: null,
      },
      requestUsageLog: [usage(126_466, 1_039)],
      messages: [{ content: 'hello', kind: undefined }],
    })
    expect(occ.source).toBe('requestUsageLog')
    expect(occ.promptTokens).toBe(126_466)
    expect(occ.responseTokens).toBe(1_039)
    expect(occ.peakTokens).toBe(126_466)
  })

  it('lastPromptTokens: 0 não esconde o snapshot (não é compactação)', () => {
    const occ = resolveSessionOccupancy({
      lastPromptTokens: 0,
      lastResponseTokens: 0,
      lastTurnSnapshot: {
        promptTokens: 128_613,
        responseTokens: 480,
        contextWindow: 262_144,
        modelName: 'glm-5.2',
      },
      messages: [{ content: 'trabalhado', kind: undefined }],
    })
    expect(occ.source).toBe('lastTurnSnapshot')
    expect(occ.promptTokens).toBe(128_613)
    expect(occ.responseTokens).toBe(480)
  })

  it('cai no requestUsageLog quando o snapshot também falta', () => {
    const occ = resolveSessionOccupancy({
      requestUsageLog: [usage(10_000, 10), usage(126_466, 1_039)],
      messages: [{ content: 'x'.repeat(400), kind: undefined }],
    })
    expect(occ.source).toBe('requestUsageLog')
    expect(occ.promptTokens).toBe(126_466)
    expect(occ.responseTokens).toBe(1_039)
    expect(occ.peakTokens).toBe(126_466)
  })

  it('depois de compactar, o 0 é real — o log antigo não ressuscita', () => {
    const occ = resolveSessionOccupancy({
      lastPromptTokens: 0,
      lastTurnSnapshot: {
        promptTokens: 0,
        responseTokens: 0,
        contextWindow: 262_144,
        modelName: 'glm-5.2',
      },
      requestUsageLog: [usage(200_000, 800)],
      messages: [{ content: 'resumo', kind: 'compact_boundary' }],
    })
    expect(occ.source).toBe('compacted')
    expect(occ.promptTokens).toBe(0)
  })

  it('sessão sem histórico fica empty, não 0% fingido de uma conversa', () => {
    const occ = resolveSessionOccupancy({
      messages: [],
    })
    expect(occ.source).toBe('empty')
    expect(occ.promptTokens).toBe(0)
  })

  it('estima pelos caracteres quando não há snapshot nem log', () => {
    const occ = resolveSessionOccupancy({
      messages: [{ content: 'abcd'.repeat(100), kind: undefined }],
    })
    expect(occ.source).toBe('estimate')
    expect(occ.promptTokens).toBe(100)
  })

  it('lastPromptTokens de usage REAL manda sobre o snapshot', () => {
    const occ = resolveSessionOccupancy({
      lastPromptTokens: 85_033,
      lastResponseTokens: 1_428,
      lastPromptFromUsage: true,
      lastTurnSnapshot: {
        promptTokens: 128_613,
        responseTokens: 0,
        contextWindow: null,
        modelName: null,
      },
    })
    expect(occ.source).toBe('lastPromptTokens')
    expect(occ.promptTokens).toBe(85_033)
    expect(occ.responseTokens).toBe(1_428)
  })

  it('estimativa 405k não pinta o pill a vermelho quando o provider ficou em ~146k', () => {
    const occ = resolveSessionOccupancy({
      lastPromptTokens: 405_674,
      lastResponseTokens: 18_309,
      lastPromptFromUsage: false,
      peakPromptTokens: 405_674,
      requestUsageLog: [
        usage(140_060, 548),
        usage(145_608, 255),
        { inputTokens: 0, outputTokens: 1, usageAvailable: true, estimatedInputTokens: 405_674 } as RequestUsageEntry,
      ],
    })
    expect(occ.source).toBe('requestUsageLog')
    expect(occ.promptTokens).toBe(145_608)
    expect(occ.responseTokens).toBe(255)
    expect(occ.peakTokens).toBe(145_608)
  })

  it('lastPromptFromUsage envenenado (405k gravado como real) ainda cede ao log', () => {
    const occ = resolveSessionOccupancy({
      lastPromptTokens: 405_674,
      lastResponseTokens: 18_309,
      lastPromptFromUsage: true,
      peakPromptTokens: 405_674,
      requestUsageLog: [usage(145_608, 255)],
    })
    expect(occ.source).toBe('requestUsageLog')
    expect(occ.promptTokens).toBe(145_608)
    expect(occ.responseTokens).toBe(255)
  })
})

describe('resolveQueryOccupancySeed — Stop + "continue" é o mesmo prato', () => {
  it('ancora no último usage REAL, não na estimativa inflacionada do pill', () => {
    const seed = resolveQueryOccupancySeed({
      lastPromptTokens: 405_674,
      lastResponseTokens: 1,
      lastPromptFromUsage: false,
      lastTurnSnapshot: {
        promptTokens: 140_060,
        responseTokens: 548,
        contextWindow: 262_144,
        modelName: 'glm-5.2',
      },
      requestUsageLog: [
        usage(140_060, 548),
        { inputTokens: 0, outputTokens: 1, usageAvailable: true, estimatedInputTokens: 405_674 } as RequestUsageEntry,
      ],
    })
    expect(seed).toEqual({ tokens: 140_060 + 548, messageCount: null })
  })

  it('usa totalMessages do pedido real quando existe', () => {
    const seed = resolveQueryOccupancySeed({
      requestUsageLog: [
        { ...usage(145_608, 1_039), totalMessages: 42 },
      ],
    })
    expect(seed).toEqual({ tokens: 145_608 + 1_039, messageCount: 42 })
  })

  it('não sementeia depois de compactar — o prato foi trocado', () => {
    const seed = resolveQueryOccupancySeed({
      lastPromptTokens: 0,
      lastTurnSnapshot: {
        promptTokens: 0,
        responseTokens: 0,
        contextWindow: 262_144,
        modelName: 'glm-5.2',
      },
      requestUsageLog: [usage(200_000, 800)],
      messages: [{ content: 'resumo', kind: 'compact_boundary' }],
    })
    expect(seed).toBeNull()
  })

  it('lastPromptFromUsage sem log ainda sementeia prompt+completion', () => {
    const seed = resolveQueryOccupancySeed({
      lastPromptTokens: 145_608,
      lastResponseTokens: 1_039,
      lastPromptFromUsage: true,
    })
    expect(seed).toEqual({ tokens: 145_608 + 1_039, messageCount: null })
  })

  it('estimativa sem usage real não sementeia — o loop conta as mensagens', () => {
    expect(resolveQueryOccupancySeed({
      lastPromptTokens: 405_674,
      lastPromptFromUsage: false,
      messages: [{ content: 'x'.repeat(1600), kind: undefined }],
    })).toBeNull()
  })
})

describe('resolveSeedMessageCount', () => {
  it('usa o total persistido quando ainda cabe no histórico', () => {
    expect(resolveSeedMessageCount(40, 42)).toBe(40)
  })

  it('cai no comprimento do histórico quando a âncora já não cabe', () => {
    expect(resolveSeedMessageCount(80, 42)).toBe(42)
  })

  it('sem histórico não há prato', () => {
    expect(resolveSeedMessageCount(40, 0)).toBeUndefined()
  })
})
