import 'openai/shims/node'
import AgentService from '../agentService'

const mockQueryEngineOptions: Array<Record<string, unknown>> = []
let mockTmSpeedEnabled = false
let mockSelectedPersona = 'standard'
// Escolha nativa do user (null = default do modelo).
let mockSelectedEffort: string | null = 'max'
// Modelo ativo (null = não enviar X-TM-Reasoning-Effort — evita max em Grok).
let mockActiveModelId: string | null = 'glm-5.2'

// Mock core modules to avoid Tauri/Firebase/Zustand errors during initialization
jest.mock('../toolExecutor', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getToolDefinitions: () => [],
      resetSessionState: jest.fn(),
      rebuildReadStateFromHistory: jest.fn(),
      setRequestType: jest.fn(),
      clearDelegateTelemetry: jest.fn(),
      consumeDelegateTelemetry: jest.fn(() => null),
      execute: jest.fn(),
    }),
  },
}))

jest.mock('../sdkClient', () => ({
  createAgentClient: jest.fn(() => ({})),
  createSubAgentClient: jest.fn(() => ({})),
}))

jest.mock('../queryEngine', () => ({
  QueryEngine: class {
    constructor(options: Record<string, unknown>) {
      mockQueryEngineOptions.push(options)
    }
    cancel() {}
    async *submitMessage() {
      yield { type: 'message_stop', usage: null }
      return { reason: 'stop', turnCount: 1 }
    }
  },
  toQueryMessages: jest.fn((messages) => messages),
}))

jest.mock('../../../i18n', () => ({
  t: (key: string) => key,
}))

jest.mock('../diffService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({}),
  },
}))

jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: jest.fn().mockResolvedValue('mock-firebase-token'),
    }),
  },
  getAppCheckHeader: jest.fn().mockResolvedValue({ 'X-Firebase-AppCheck': 'mock-appcheck' }),
}))

jest.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      getActiveSession: () => ({ id: 'mock-session-id' }),
    }),
  },
}))

jest.mock('../../../stores/billingStore', () => ({
  useBillingStore: {
    getState: () => ({
      clearNoCredits: jest.fn(),
      updateFromHeaders: jest.fn(),
    }),
  },
}))

jest.mock('../../../stores/tmSpeedStore', () => ({
  useTmSpeedStore: {
    getState: () => ({
      enabled: mockTmSpeedEnabled,
    }),
  },
}))

// Persona (Escolha do Modelo): sempre presente no caminho gerido não-lightweight
// — o default 'standard' faz parte do contrato de headers desde 2026-08-04.
jest.mock('../../../stores/personaStore', () => ({
  usePersonaStore: {
    getState: () => ({
      selected: mockSelectedPersona,
    }),
  },
}))

jest.mock('../../../stores/reasoningEffortStore', () => ({
  useReasoningEffortStore: {
    getState: () => ({
      selected: mockSelectedEffort,
    }),
  },
}))

jest.mock('../../../stores/activeModelStore', () => ({
  useActiveModelStore: {
    getState: () => ({
      activeModelId: mockActiveModelId,
    }),
  },
}))

let mockAgentModelName: string | null = null
jest.mock('../../../stores/agentStore', () => ({
  useAgentStore: {
    getState: () => ({
      status: 'idle',
      modelName: mockAgentModelName,
      setModelInfo: jest.fn(),
      setByokActive: jest.fn(),
      setWorkerStatus: jest.fn(),
    }),
  },
}))

jest.mock('../../../stores/byokStore', () => ({
  useByokStore: {
    getState: () => ({
      resolveActive: jest.fn().mockReturnValue(null),
    }),
  },
}))

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn(),
}))

jest.mock('../../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))

jest.mock('../../../stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({
      addToast: jest.fn(),
    }),
  },
}))

jest.mock('../../../utils/devUrls', () => ({
  resolveWorkerUrl: () => 'https://worker.test',
}))

describe('AgentService X-Request-Type header stickiness', () => {
  let agentService: AgentService
  const callbacks = {
    onTextDelta: jest.fn(),
    onReasoningDelta: jest.fn(),
    onToolCallPending: jest.fn(),
    onToolCallStart: jest.fn(),
    onToolResult: jest.fn(),
    onTurnComplete: jest.fn(),
    onDone: jest.fn(),
    onError: jest.fn(),
    onUsageUpdate: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryEngineOptions.length = 0
    mockTmSpeedEnabled = false
    mockSelectedEffort = 'max'
    mockActiveModelId = 'glm-5.2'
    mockAgentModelName = null
    agentService = AgentService.createLightweight({ tools: [], maxTurns: 1 })
  })

  afterEach(() => {
    // Reset singleton requestType state
    agentService.setRequestType(null)
  })

  it.each(['plan', 'debug', 'e2e', 'review', 'some-other-type'])(
    'passes requestType "%s" to QueryEngine extraHeaders until cleared',
    async (requestType) => {
      agentService.setRequestType(requestType)

      await agentService.runAgentLoop('hello', [], callbacks)
      await agentService.runAgentLoop('again', [], callbacks)

      expect(mockQueryEngineOptions).toHaveLength(2)
      expect(mockQueryEngineOptions[0].extraHeaders).toEqual({ 'X-Request-Type': requestType })
      expect(mockQueryEngineOptions[1].extraHeaders).toEqual({ 'X-Request-Type': requestType })
      expect(agentService.getRequestType()).toBe(requestType)

      agentService.setRequestType(null)
      await agentService.runAgentLoop('plain', [], callbacks)

      expect(mockQueryEngineOptions[2].extraHeaders).toBeUndefined()
      expect(agentService.getRequestType()).toBeNull()
    },
  )
})

describe('AgentService X-TM-Speed header', () => {
  const speedCallbacks = {
    onTextDelta: jest.fn(),
    onReasoningDelta: jest.fn(),
    onToolCallPending: jest.fn(),
    onToolCallStart: jest.fn(),
    onToolResult: jest.fn(),
    onTurnComplete: jest.fn(),
    onDone: jest.fn(),
    onError: jest.fn(),
    onUsageUpdate: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryEngineOptions.length = 0
    mockTmSpeedEnabled = false
    mockSelectedEffort = 'max'
    // Repor SEMPRE os dois sinais de modelo: desde a inversão served-first
    // (05-08) um mockAgentModelName esquecido de um teste anterior ganha ao
    // Firestore e contamina o teste seguinte.
    mockActiveModelId = 'glm-5.2'
    mockAgentModelName = null
  })

  afterEach(() => {
    mockTmSpeedEnabled = false
    mockSelectedEffort = 'max'
    mockActiveModelId = 'glm-5.2'
    mockAgentModelName = null
    AgentService.getInstance().setRequestType(null)
  })

  it('adds X-TM-Speed for the main agent when TM Speed is enabled', () => {
    mockTmSpeedEnabled = true
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    // Com uma escolha nativa ativa ('max'), o agente principal envia o header.
    expect(headers).toEqual({ 'X-TM-Speed': 'true', 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'max' })
  })

  it('combines X-TM-Speed with X-Request-Type when both are present', () => {
    mockTmSpeedEnabled = true
    const service = AgentService.getInstance()
    service.setRequestType('plan')

    const headers = (service as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-Request-Type': 'plan', 'X-TM-Speed': 'true', 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'max' })
  })

  it('sends the user reasoning-effort (native value) on the main agent (managed)', () => {
    mockSelectedEffort = 'high'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'high' })
  })

  it('maps legacy GLM effort aliases before sending (medium → high)', () => {
    mockSelectedEffort = 'medium'
    mockActiveModelId = 'glm-5.2'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'high' })
  })

  it('sends the model DEFAULT reasoning-effort when the user made no choice', () => {
    // Sem escolha do user, envia-se o DEFAULT oficial do modelo (GLM → max).
    mockSelectedEffort = null
    mockActiveModelId = 'glm-5.2'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'max' })
  })

  it('sends Grok official default high when model is grok-4.5 and user made no choice', () => {
    mockSelectedEffort = null
    mockActiveModelId = 'grok-4.5'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'high' })
  })

  it('does not send X-TM-Reasoning-Effort when active model is unknown', () => {
    // Evita mandar o default GLM `max` a um Grok ainda não detetado → 400.
    mockSelectedEffort = 'high'
    mockActiveModelId = null
    mockAgentModelName = null
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    // Sem effort (modelo desconhecido), mas a persona vai sempre no gerido.
    expect(headers).toEqual({ 'X-TM-Persona': 'standard' })
  })

  it('falls back to agentStore.modelName (X-TM-Model) when Firestore model is null', () => {
    // Bug fix: seletor via headerModel mostrava Grok/Low mas o header não
    // saía porque só lia activeModelStore.
    mockSelectedEffort = 'low'
    mockActiveModelId = null
    mockAgentModelName = 'grok-4.5'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'low' })
  })

  it('sends Grok low as low (not GLM-legacy-mapped to high)', () => {
    mockSelectedEffort = 'low'
    mockActiveModelId = 'grok-4.5'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'low' })
  })

  it('sends Kimi low/high/max natively; medium falls back to max default', () => {
    mockActiveModelId = 'kimi-k3'
    mockSelectedEffort = 'low'
    let headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()
    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'low' })

    mockSelectedEffort = 'high'
    headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()
    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'high' })

    mockSelectedEffort = 'max'
    headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()
    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'max' })

    // Preferência legada do Grok (medium) → default Kimi max
    mockSelectedEffort = 'medium'
    headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()
    expect(headers).toEqual({ 'X-TM-Persona': 'standard', 'X-TM-Reasoning-Effort': 'max' })
  })

  it('does not send X-TM-Reasoning-Effort for unmapped models', () => {
    mockSelectedEffort = 'high'
    mockActiveModelId = 'mimo-v2.5'
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    // Sem effort (modelo fora do mapa), mas a persona vai sempre no gerido.
    expect(headers).toEqual({ 'X-TM-Persona': 'standard' })
  })

  it('does not add X-TM-Speed to lightweight sidecar agents', async () => {
    mockTmSpeedEnabled = true
    const lightweight = AgentService.createLightweight({ tools: [], maxTurns: 1 })

    await lightweight.runAgentLoop('sidecar', [], speedCallbacks)

    expect(mockQueryEngineOptions).toHaveLength(1)
    expect(mockQueryEngineOptions[0].extraHeaders).toBeUndefined()
  })

  it('enables tracker reconciliation reminders only for the main agent', async () => {
    const main = AgentService.getInstance()
    await main.runAgentLoop('main task', [], speedCallbacks)

    const lightweight = AgentService.createLightweight({ tools: [], maxTurns: 1 })
    await lightweight.runAgentLoop('sidecar task', [], speedCallbacks)

    expect(mockQueryEngineOptions).toHaveLength(2)
    expect(mockQueryEngineOptions[0].enableTaskTrackerReminder).toBe(true)
    expect(mockQueryEngineOptions[1].enableTaskTrackerReminder).toBe(false)
  })
})
