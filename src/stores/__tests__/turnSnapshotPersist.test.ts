// Mocks antes do import — o chatStore liga-os no carregamento do módulo.
const mockSetTurnSnapshotGetter = jest.fn()

jest.mock('../../services/agent/sessionService', () => ({
  sessionService: {
    setSessionGetter: jest.fn(),
    setTokenUsageGetter: jest.fn(),
    setTurnSnapshotGetter: mockSetTurnSnapshotGetter,
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
import { useAgentStore } from '../agentStore'
import type { ChatSession, SessionTurnSnapshot } from '../../types/chat'

/** O getter que o chatStore registou no sessionService ao carregar. */
function snapshotGetter(): () => SessionTurnSnapshot | null {
  const call = mockSetTurnSnapshotGetter.mock.calls[0]
  if (!call) throw new Error('chatStore não registou o turn-snapshot getter')
  return call[0] as () => SessionTurnSnapshot | null
}

function seedSession(lastTurnSnapshot?: SessionTurnSnapshot): string {
  const id = 'sess-test'
  const session = {
    id,
    projectPath: '/proj',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(lastTurnSnapshot ? { lastTurnSnapshot } : {}),
  } as unknown as ChatSession
  useChatStore.setState({ sessions: new Map([[id, session]]), activeSessionId: id })
  return id
}

/**
 * O snapshot de turno é o que faz a pill sobreviver a um reload.
 *
 * O persist RECONSTRÓI o ficheiro da sessão a cada save. Por isso devolver
 * null neste getter não "deixa como está" — APAGA o snapshot anterior. Um save
 * disparado com o estado vivo vazio (arranque, pós-reset de troca de projecto,
 * autosave em idle) destruía a última janela conhecida.
 *
 * Consequência observada (screenshot katondo, 29-07): sessões com horas de
 * trabalho exportavam `lastTurnSnapshot: null`, a pill renascia no
 * FALLBACK_CONTEXT_WINDOW de 200K e anunciava "Pressão 251.7% (overrun) —
 * Compaction is overdue" para um modelo de 1M, enquanto o auto-compact usava a
 * janela real e por isso não compactava. O alarme era a pill, não o motor.
 */
describe('turn snapshot: o persist nunca apaga a última janela conhecida', () => {
  beforeEach(() => {
    useAgentStore.setState({ modelContextWindow: null, modelName: null })
    useChatStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      currentPromptTokens: 0,
      currentResponseTokens: 0,
    })
  })

  it('sem estado vivo, devolve o snapshot já persistido em vez de null', () => {
    const persisted: SessionTurnSnapshot = {
      promptTokens: 453_100,
      responseTokens: 29_300,
      contextWindow: 1_000_000,
      modelName: 'glm-5.2',
    }
    seedSession(persisted)

    expect(snapshotGetter()()).toEqual(persisted)
  })

  it('sem estado vivo E sem nada persistido, devolve null (não inventa)', () => {
    seedSession()
    expect(snapshotGetter()()).toBeNull()
  })

  it('o header vivo manda sobre o persistido', () => {
    seedSession({ promptTokens: 1, responseTokens: 1, contextWindow: 200_000, modelName: 'antigo' })
    useAgentStore.setState({ modelContextWindow: 1_000_000, modelName: 'glm-5.2' })
    useChatStore.setState({ currentPromptTokens: 42, currentResponseTokens: 7 })

    expect(snapshotGetter()()).toEqual({
      promptTokens: 42,
      responseTokens: 7,
      contextWindow: 1_000_000,
      modelName: 'glm-5.2',
    })
  })

  it('com tokens vivos mas SEM header, herda a janela persistida', () => {
    // O caso exacto do incidente: o run continua (há tokens deste turno) mas o
    // header desapareceu do store. Antes, isto persistia contextWindow: null.
    seedSession({ promptTokens: 10, responseTokens: 2, contextWindow: 1_000_000, modelName: 'glm-5.2' })
    useChatStore.setState({ currentPromptTokens: 453_100, currentResponseTokens: 29_300 })

    const out = snapshotGetter()()
    expect(out?.contextWindow).toBe(1_000_000)
    expect(out?.modelName).toBe('glm-5.2')
    expect(out?.promptTokens).toBe(453_100)
  })
})
