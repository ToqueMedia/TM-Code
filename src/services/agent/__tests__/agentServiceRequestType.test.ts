import 'openai/shims/node'
import AgentService from '../agentService'

const mockQueryEngineOptions: Array<Record<string, unknown>> = []
let mockTmSpeedEnabled = false

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

jest.mock('../../../stores/agentStore', () => ({
  useAgentStore: {
    getState: () => ({
      status: 'idle',
      setModelInfo: jest.fn(),
      setByokActive: jest.fn(),
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
  })

  afterEach(() => {
    mockTmSpeedEnabled = false
    AgentService.getInstance().setRequestType(null)
  })

  it('adds X-TM-Speed for the main agent when TM Speed is enabled', () => {
    mockTmSpeedEnabled = true
    const headers = (AgentService.getInstance() as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-TM-Speed': 'true' })
  })

  it('combines X-TM-Speed with X-Request-Type when both are present', () => {
    mockTmSpeedEnabled = true
    const service = AgentService.getInstance()
    service.setRequestType('plan')

    const headers = (service as unknown as { buildExtraHeaders: () => Record<string, string> | undefined }).buildExtraHeaders()

    expect(headers).toEqual({ 'X-Request-Type': 'plan', 'X-TM-Speed': 'true' })
  })

  it('does not add X-TM-Speed to lightweight sidecar agents', async () => {
    mockTmSpeedEnabled = true
    const lightweight = AgentService.createLightweight({ tools: [], maxTurns: 1 })

    await lightweight.runAgentLoop('sidecar', [], speedCallbacks)

    expect(mockQueryEngineOptions).toHaveLength(1)
    expect(mockQueryEngineOptions[0].extraHeaders).toBeUndefined()
  })
})
