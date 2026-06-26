// Mock dependencies before importing chatStore — chatStore wires them on module load
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
  default: {
    getInstance: () => ({
      registerDiff: jest.fn(),
      acceptDiff: jest.fn(),
      rejectDiff: jest.fn(),
    }),
  },
  DiffResult: {},
}))

jest.mock('../../utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

import { useChatStore } from '../chatStore'

// Helper: reset the store to initial state before each test
function resetStore() {
  useChatStore.setState({
    sessions: new Map(),
    activeSessionId: null,
    isStreaming: false,
    isLoadingSession: false,
    streamingMessageId: null,
    error: null,
    conversationHistory: [],
    currentTurnCount: 0,
    totalTokensUsed: { input: 0, output: 0 },
    currentPromptTokens: 0,
    currentResponseTokens: 0,
    pendingDiffs: [],
  })
}

describe('chatStore', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('initial state', () => {
    it('has no active session', () => {
      const state = useChatStore.getState()
      expect(state.activeSessionId).toBeNull()
      expect(state.sessions.size).toBe(0)
    })

    it('is not streaming', () => {
      const state = useChatStore.getState()
      expect(state.isStreaming).toBe(false)
      expect(state.streamingMessageId).toBeNull()
    })

    it('has no error', () => {
      expect(useChatStore.getState().error).toBeNull()
    })

    it('has zero token usage', () => {
      const { totalTokensUsed } = useChatStore.getState()
      expect(totalTokensUsed.input).toBe(0)
      expect(totalTokensUsed.output).toBe(0)
    })
  })

  describe('createSession', () => {
    it('creates a session and sets it as active', () => {
      const sessionId = useChatStore.getState().createSession('/test/project')
      const state = useChatStore.getState()

      expect(sessionId).toBeTruthy()
      expect(state.activeSessionId).toBe(sessionId)
      expect(state.sessions.has(sessionId)).toBe(true)
    })

    it('initializes the session with correct fields', () => {
      const sessionId = useChatStore.getState().createSession('/test/project')
      const session = useChatStore.getState().sessions.get(sessionId)

      expect(session).toBeDefined()
      expect(session!.projectPath).toBe('/test/project')
      expect(session!.messages).toEqual([])
      expect(session!.status).toBe('idle')
      expect(session!.createdAt).toBeGreaterThan(0)
    })
  })

  describe('addUserMessage', () => {
    it('adds a user message to the active session', () => {
      const sessionId = useChatStore.getState().createSession('/test/project')
      const msgId = useChatStore.getState().addUserMessage('Hello world')

      expect(msgId).toBeTruthy()
      const session = useChatStore.getState().sessions.get(sessionId)!
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].role).toBe('user')
      expect(session.messages[0].content).toBe('Hello world')
    })

    it('does nothing when there is no active session', () => {
      // No session created
      const msgId = useChatStore.getState().addUserMessage('orphan message')
      // Still returns an id, but sessions remain empty
      expect(msgId).toBeTruthy()
      expect(useChatStore.getState().sessions.size).toBe(0)
    })
  })

  describe('startAssistantMessage / appendTextDelta / finalizeAssistantMessage', () => {
    it('streams an assistant message', () => {
      useChatStore.getState().createSession('/test/project')
      const assistantId = useChatStore.getState().startAssistantMessage()

      expect(useChatStore.getState().isStreaming).toBe(true)
      expect(useChatStore.getState().streamingMessageId).toBe(assistantId)

      useChatStore.getState().appendTextDelta('Hello ')
      useChatStore.getState().appendTextDelta('world')

      const session = useChatStore.getState().getActiveSession()!
      const msg = session.messages.find(m => m.id === assistantId)!
      expect(msg.content).toBe('Hello world')
      expect(msg.isStreaming).toBe(true)

      useChatStore.getState().finalizeAssistantMessage()
      expect(useChatStore.getState().isStreaming).toBe(false)
      expect(useChatStore.getState().streamingMessageId).toBeNull()

      const finalMsg = useChatStore.getState().getActiveSession()!.messages.find(m => m.id === assistantId)!
      expect(finalMsg.isStreaming).toBe(false)
    })
  })

  describe('splitForQueuedMessage', () => {
    it('finalises the streaming assistant, appends user msg AT THE END, and starts a new streaming assistant', () => {
      useChatStore.getState().createSession('/test/project')
      useChatStore.getState().addUserMessage('start the build')
      const oldAssistantId = useChatStore.getState().startAssistantMessage()
      useChatStore.getState().appendTextDelta('Working on Task 1...')

      // Simulate a queued message dispatching mid-stream
      const newAssistantId = useChatStore
        .getState()
        .splitForQueuedMessage('also use mercury-2 instead of mercury-coder-small')

      const session = useChatStore.getState().getActiveSession()!
      // Messages should be: user, oldAssistant, queuedUser, newAssistant
      expect(session.messages).toHaveLength(4)
      expect(session.messages[0]?.role).toBe('user')
      expect(session.messages[1]?.id).toBe(oldAssistantId)
      expect(session.messages[1]?.role).toBe('assistant')
      expect(session.messages[1]?.isStreaming).toBe(false) // finalised
      expect(session.messages[2]?.role).toBe('user')
      expect(session.messages[2]?.content).toBe('also use mercury-2 instead of mercury-coder-small')
      expect(session.messages[3]?.id).toBe(newAssistantId)
      expect(session.messages[3]?.role).toBe('assistant')
      expect(session.messages[3]?.isStreaming).toBe(true)

      // streamingMessageId now points to the NEW assistant
      expect(useChatStore.getState().streamingMessageId).toBe(newAssistantId)
      // overall streaming state remains true (the loop is ongoing)
      expect(useChatStore.getState().isStreaming).toBe(true)
    })

    it('routes subsequent appendTextDelta calls into the new assistant bubble', () => {
      useChatStore.getState().createSession('/test/project')
      const oldAssistantId = useChatStore.getState().startAssistantMessage()
      useChatStore.getState().appendTextDelta('Phase 1 progress...')

      const newAssistantId = useChatStore.getState().splitForQueuedMessage('quick question about X')

      // After split, deltas land in the new bubble — not the finalised one.
      useChatStore.getState().appendTextDelta('Answering quickly: ')
      useChatStore.getState().appendTextDelta('Y is the reason. Resuming...')

      const session = useChatStore.getState().getActiveSession()!
      const oldMsg = session.messages.find(m => m.id === oldAssistantId)!
      const newMsg = session.messages.find(m => m.id === newAssistantId)!
      expect(oldMsg.content).toBe('Phase 1 progress...')
      expect(newMsg.content).toBe('Answering quickly: Y is the reason. Resuming...')
    })

    it('preserves attachments and promptBlocks on the queued user message', () => {
      useChatStore.getState().createSession('/test/project')
      useChatStore.getState().startAssistantMessage()

      useChatStore.getState().splitForQueuedMessage(
        'with attachment',
        [{ id: 'att-1', name: 'screenshot.png', path: '/tmp/screenshot.png', type: 'image', mimeType: 'image/png', sizeBytes: 100 }],
        [{ type: 'text', text: 'with attachment' }],
      )

      const session = useChatStore.getState().getActiveSession()!
      const queuedUserMsg = session.messages.find(m => m.role === 'user')!
      expect(queuedUserMsg.attachments).toHaveLength(1)
      expect(queuedUserMsg.attachments?.[0]?.name).toBe('screenshot.png')
      expect(queuedUserMsg.promptBlocks).toHaveLength(1)
    })
  })

  describe('setError', () => {
    it('sets and clears error', () => {
      useChatStore.getState().setError('Something broke')
      expect(useChatStore.getState().error).toBe('Something broke')

      useChatStore.getState().setError(null)
      expect(useChatStore.getState().error).toBeNull()
    })
  })

  describe('clearSession', () => {
    it('removes the session and resets active session if it was active', () => {
      const sessionId = useChatStore.getState().createSession('/test/project')
      expect(useChatStore.getState().sessions.has(sessionId)).toBe(true)

      useChatStore.getState().clearSession(sessionId)
      expect(useChatStore.getState().sessions.has(sessionId)).toBe(false)
      expect(useChatStore.getState().activeSessionId).toBeNull()
    })
  })

  describe('isLoadingSession state transitions', () => {
    it('starts as false', () => {
      expect(useChatStore.getState().isLoadingSession).toBe(false)
    })

    it('can be toggled via setState (simulating loadSessionFromDisk)', () => {
      useChatStore.setState({ isLoadingSession: true })
      expect(useChatStore.getState().isLoadingSession).toBe(true)

      useChatStore.setState({ isLoadingSession: false })
      expect(useChatStore.getState().isLoadingSession).toBe(false)
    })
  })

  describe('token usage tracking', () => {
    it('totalTokensUsed tracks MAX input + SUM output across calls', () => {
      // `totalTokensUsed.input` is MAX, not SUM. Summing input gave the
      // visible "↑ 904k" symptom across 60+ tool-loop turns while the actual
      // context-pressure pill read 15 % of 256 K = 38 K — each turn already
      // contains the previous turns' input as history echo, so summing
      // double-counts. MAX is the high-water mark of wire-side input across
      // the request.
      //
      // `totalTokensUsed.output` is SUM — each turn emits NEW output tokens
      // (not history echo), so summing them is "how much we generated
      // this request" which is the meaningful aggregate.
      //
      // See addTokenUsage's comment block (chatStore.ts ~line 2020) for the
      // full rationale and the bug that drove the 2026-05-02 refactor from
      // SUM to MAX. The window-pressure pill combines the live/persisted
      // input and output counters against the effective model window.
      useChatStore.getState().addTokenUsage(100, 50)
      useChatStore.getState().addTokenUsage(200, 75)

      const { totalTokensUsed, currentPromptTokens, currentResponseTokens } = useChatStore.getState()
      expect(totalTokensUsed.input).toBe(200)   // MAX(100, 200)
      expect(totalTokensUsed.output).toBe(125)  // 50 + 75
      // Per-turn fields: input is replaced (last positive value wins);
      // output is always overwritten with the latest call.
      expect(currentPromptTokens).toBe(200)
      expect(currentResponseTokens).toBe(75)
    })

    it('tracks live estimated context before provider usage arrives', () => {
      useChatStore.getState().addEstimatedTokenUsage(120, 10)
      useChatStore.getState().addEstimatedTokenUsage(100, 25)

      let state = useChatStore.getState()
      expect(state.currentPromptTokens).toBe(120)
      expect(state.currentResponseTokens).toBe(25)
      expect(state.totalTokensUsed).toEqual({ input: 0, output: 0 })

      useChatStore.getState().addTokenUsage(140, 30)
      state = useChatStore.getState()
      expect(state.currentPromptTokens).toBe(140)
      expect(state.currentResponseTokens).toBe(30)
      expect(state.totalTokensUsed).toEqual({ input: 140, output: 30 })
    })
  })

  describe('turn count', () => {
    it('increments turn count', () => {
      expect(useChatStore.getState().currentTurnCount).toBe(0)

      useChatStore.getState().incrementTurnCount()
      useChatStore.getState().incrementTurnCount()

      expect(useChatStore.getState().currentTurnCount).toBe(2)
    })
  })

  describe('pending diffs', () => {
    const mockDiff = {
      id: 'diff-1',
      filePath: '/test/file.ts',
      originalContent: 'old',
      newContent: 'new',
      isNewFile: false,
      status: 'pending' as const,
    }

    it('adds a pending diff', () => {
      useChatStore.getState().addPendingDiff(mockDiff)
      expect(useChatStore.getState().pendingDiffs).toHaveLength(1)
      expect(useChatStore.getState().pendingDiffs[0].id).toBe('diff-1')
    })

    it('removes a pending diff by id', () => {
      useChatStore.getState().addPendingDiff(mockDiff)
      useChatStore.getState().removePendingDiff('diff-1')
      expect(useChatStore.getState().pendingDiffs).toHaveLength(0)
    })

    it('clears all pending diffs', () => {
      useChatStore.getState().addPendingDiff(mockDiff)
      useChatStore.getState().addPendingDiff({ ...mockDiff, id: 'diff-2' })
      useChatStore.getState().clearPendingDiffs()
      expect(useChatStore.getState().pendingDiffs).toHaveLength(0)
    })
  })
})
