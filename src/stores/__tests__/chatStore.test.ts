// Mock dependencies before importing chatStore — chatStore wires them on module load
jest.mock('../../services/agent/sessionService', () => ({
  sessionService: {
    setSessionGetter: jest.fn(),
    setTokenUsageGetter: jest.fn(),
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
    it('input takes max (current context size), output accumulates (new tokens emitted)', () => {
      // Each turn re-sends the full conversation, so input=200 already
      // contains the work that input=100 represented. Summing inputs would
      // double-count. Output, by contrast, is fresh tokens generated each
      // turn — those add up.
      useChatStore.getState().addTokenUsage(100, 50)
      useChatStore.getState().addTokenUsage(200, 75)

      const { totalTokensUsed } = useChatStore.getState()
      expect(totalTokensUsed.input).toBe(200)
      expect(totalTokensUsed.output).toBe(125)
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
