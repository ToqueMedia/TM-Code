// Mocks antes do import — o chatStore liga-os no carregamento do módulo.
jest.mock('../../services/agent/sessionService', () => ({
  sessionService: {
    setSessionGetter: jest.fn(),
    setTokenUsageGetter: jest.fn(),
    setTurnSnapshotGetter: jest.fn(),
    markDirty: jest.fn(),
    flushNow: jest.fn().mockResolvedValue(undefined),
    init: jest.fn().mockResolvedValue(undefined),
    startAutoSave: jest.fn(),
    stopAutoSave: jest.fn(),
    saveSession: jest.fn().mockResolvedValue(undefined),
    loadSession: jest.fn().mockResolvedValue(null),
    getActiveSessionId: jest.fn().mockResolvedValue(null),
    setActiveSessionId: jest.fn().mockResolvedValue(undefined),
    listSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn(),
    cleanupEmptySessions: jest.fn().mockResolvedValue(undefined),
  },
  captureByokSnapshot: jest.fn(() => null),
}))

jest.mock('../../services/agent/diffService', () => ({
  __esModule: true,
  default: { getInstance: () => ({ registerDiff: jest.fn(), acceptDiff: jest.fn(), rejectDiff: jest.fn() }) },
  DiffResult: {},
}))

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

jest.mock('../../services/agent/skillService', () => ({ clearInvokedSkills: jest.fn() }))

import { useChatStore } from '../chatStore'

/**
 * A ocupação de contexto que o pill mostra tem de SUBIR E DESCER.
 *
 * Sintoma reportado (2026-08-05): "vi a janela de contexto a travar nos 49% e
 * daí nunca andou". `lastPromptTokens` era um pico de sessão (`Math.max`) que
 * só o caminho de compactação repunha, e o indicador aplicava outro
 * `Math.max(live, persisted)` por cima — resultado: um único turno grande
 * fixava a barra para sempre, escondia o efeito da micro-compactação, e
 * divergia do runtime (o autoCompact ancora na ocupação REAL do turno
 * anterior, que desce quando o prompt encolhe).
 *
 * Estes testes fixam o contrato novo: `lastPromptTokens` = ocupação corrente,
 * `peakPromptTokens` = pico (informação secundária), e o primeiro plano é o
 * único que escreve.
 */
function seedSession(): string {
  useChatStore.setState({
    sessions: new Map(),
    activeSessionId: null,
    currentPromptTokens: 0,
    currentResponseTokens: 0,
    totalTokensUsed: { input: 0, output: 0 },
  })
  return useChatStore.getState().createSession('/test/project')
}

function activeSession() {
  const s = useChatStore.getState()
  return s.sessions.get(s.activeSessionId!)!
}

describe('ocupação de contexto (pill)', () => {
  it('DESCE quando o prompt do turno seguinte é menor', () => {
    seedSession()
    useChatStore.getState().addTokenUsage(500_000, 1_000, true)
    expect(activeSession().lastPromptTokens).toBe(500_000)

    // Micro-compactação / snip de tool results: o prompt encolhe mesmo.
    useChatStore.getState().addTokenUsage(120_000, 800, true)
    expect(activeSession().lastPromptTokens).toBe(120_000)
  })

  it('guarda o pico à parte, sem deixá-lo mandar na ocupação', () => {
    seedSession()
    useChatStore.getState().addTokenUsage(500_000, 1_000, true)
    useChatStore.getState().addTokenUsage(120_000, 800, true)

    const session = activeSession()
    expect(session.peakPromptTokens).toBe(500_000)
    expect(session.lastPromptTokens).toBe(120_000)
  })

  it('runs de fundo não mexem na ocupação nem no pico', () => {
    seedSession()
    useChatStore.getState().addTokenUsage(200_000, 500, true)
    useChatStore.getState().addTokenUsage(3_000, 100, false)

    const session = activeSession()
    expect(session.lastPromptTokens).toBe(200_000)
    expect(session.peakPromptTokens).toBe(200_000)
  })

  it('usage parcial sem prompt_tokens (BYOK) não zera a ocupação', () => {
    seedSession()
    useChatStore.getState().addTokenUsage(200_000, 500, true)
    useChatStore.getState().addTokenUsage(0, 300, true)

    expect(activeSession().lastPromptTokens).toBe(200_000)
  })

  it('a compactação repõe ocupação E pico', () => {
    seedSession()
    useChatStore.getState().addTokenUsage(500_000, 1_000, true)
    useChatStore.getState().resetTokenCounters()

    const session = activeSession()
    expect(session.lastPromptTokens).toBe(0)
    expect(session.peakPromptTokens).toBe(0)
  })

  it('o caminho estimado (BYOK sem usage) respeita o mesmo contrato', () => {
    seedSession()
    useChatStore.getState().addEstimatedTokenUsage(90_000, 400, true)
    expect(activeSession().lastPromptTokens).toBe(90_000)

    // Fundo: não escreve (antes deste fix, este caminho não tinha guarda).
    useChatStore.getState().addEstimatedTokenUsage(5_000, 50, false)
    expect(activeSession().lastPromptTokens).toBe(90_000)
  })
})
