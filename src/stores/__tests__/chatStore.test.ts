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

// clearAllSessions dynamic-imports this to drop the invoked-skills cache —
// keep it inert so the test doesn't pull the real skill machinery.
jest.mock('../../services/agent/skillService', () => ({
  clearInvokedSkills: jest.fn(),
}))

import {
  useChatStore,
  createDiffApprovalPromise,
  hasPendingDiffApprovals,
  getPendingDiffApprovalToolIds,
  resolveAllPendingDiffApprovals,
  resolveDiffApproval,
} from '../chatStore'

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

    it('stamps wasInterrupted when finalized with interrupted and content exists', () => {
      useChatStore.getState().createSession('/test/project')
      const assistantId = useChatStore.getState().startAssistantMessage()
      useChatStore.getState().appendTextDelta('partial answer')

      useChatStore.getState().finalizeAssistantMessage({ interrupted: true })

      const msg = useChatStore.getState().getActiveSession()!.messages.find(m => m.id === assistantId)!
      expect(msg.wasInterrupted).toBe(true)
    })

    it('does NOT stamp wasInterrupted on an empty bubble or a normal finalize', () => {
      useChatStore.getState().createSession('/test/project')
      const emptyId = useChatStore.getState().startAssistantMessage()
      useChatStore.getState().finalizeAssistantMessage({ interrupted: true })
      const empty = useChatStore.getState().getActiveSession()!.messages.find(m => m.id === emptyId)!
      expect(empty.wasInterrupted).toBeUndefined()

      const normalId = useChatStore.getState().startAssistantMessage()
      useChatStore.getState().appendTextDelta('done')
      useChatStore.getState().finalizeAssistantMessage()
      const normal = useChatStore.getState().getActiveSession()!.messages.find(m => m.id === normalId)!
      expect(normal.wasInterrupted).toBeUndefined()
    })

    it('marks UI-only streaming text separately from model text', () => {
      useChatStore.getState().createSession('/test/project')
      const assistantId = useChatStore.getState().startAssistantMessage()

      useChatStore.getState().appendUiTextDelta('Preparing context...\n\n')
      useChatStore.getState().appendTextDelta('Final answer')

      const session = useChatStore.getState().getActiveSession()!
      const msg = session.messages.find(m => m.id === assistantId)!
      expect(msg.content).toBe('Preparing context...\n\nFinal answer')
      expect(msg.contentBlocks).toEqual([
        { type: 'text', text: 'Preparing context...\n\n', uiOnly: true },
        { type: 'text', text: 'Final answer' },
      ])
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

  describe('clearAllSessions', () => {
    it('rejects pending diff approvals so an orphaned run unblocks', async () => {
      // Project-switch path: a run can be blocked awaiting a diff decision
      // while clearAllSessions fires WITHOUT cancelLoop having run first.
      // The module-level approval map survives the set() wipe, so an
      // unresolved entry would keep the orphaned run's executor awaiting
      // forever (and the global tool-pause gate engaged for the next project).
      const approval = createDiffApprovalPromise('tool-call-orphan')
      expect(hasPendingDiffApprovals()).toBe(true)

      useChatStore.getState().clearAllSessions()

      await expect(approval).resolves.toBe(false)
      expect(hasPendingDiffApprovals()).toBe(false)
    })

    it('preserveLiveRuns keeps streaming session + cursor (F2 park)', () => {
      const sid = useChatStore.getState().createSession('/work/proj-a')
      useChatStore.getState().startAssistantMessage()
      const { streamingMessageId, streamingSessionId } = useChatStore.getState()
      expect(streamingSessionId).toBe(sid)
      expect(streamingMessageId).toBeTruthy()

      useChatStore.getState().clearAllSessions({ preserveLiveRuns: true })

      const st = useChatStore.getState()
      expect(st.sessions.has(sid)).toBe(true)
      expect(st.streamingSessionId).toBe(sid)
      expect(st.streamingMessageId).toBe(streamingMessageId)
      expect(st.isStreaming).toBe(true)
      // View is cleared so the new project can load its active session
      expect(st.activeSessionId).toBeNull()
    })

    it('preserveLiveRuns keeps pinStreamingSession before assistant bubble (prep race)', () => {
      const sid = useChatStore.getState().createSession('/work/proj-a')
      useChatStore.getState().pinStreamingSession(sid)
      expect(useChatStore.getState().streamingSessionId).toBe(sid)
      expect(useChatStore.getState().isStreaming).toBe(false)

      useChatStore.getState().clearAllSessions({ preserveLiveRuns: true })

      const st = useChatStore.getState()
      expect(st.sessions.has(sid)).toBe(true)
      expect(st.streamingSessionId).toBe(sid)
    })

    it('startAssistantMessage respects boundSessionId after active moved', () => {
      const sidA = useChatStore.getState().createSession('/work/proj-a')
      const sidB = useChatStore.getState().createSession('/work/proj-b')
      // Simulate switch: active is B, but run belongs to A
      useChatStore.setState({ activeSessionId: sidB })
      useChatStore.getState().startAssistantMessage(undefined, null, sidA)

      const st = useChatStore.getState()
      expect(st.streamingSessionId).toBe(sidA)
      expect(st.sessions.get(sidA)?.messages.some(m => m.role === 'assistant')).toBe(true)
      expect(st.sessions.get(sidB)?.messages.some(m => m.role === 'assistant')).toBe(false)
    })

    it('preserveLiveRuns does NOT reject pending diffs', async () => {
      const sid = useChatStore.getState().createSession('/work/proj-a')
      useChatStore.getState().startAssistantMessage()
      const approval = createDiffApprovalPromise('tool-call-parked')
      expect(hasPendingDiffApprovals()).toBe(true)

      useChatStore.getState().clearAllSessions({ preserveLiveRuns: true })

      // Diff must still be pending — the parked run is waiting on it
      expect(hasPendingDiffApprovals()).toBe(true)
      expect(useChatStore.getState().sessions.has(sid)).toBe(true)

      // Cleanup so other tests don't hang
      resolveDiffApproval('tool-call-parked', false)
      await expect(approval).resolves.toBe(false)
    })
  })


  describe('rewindToToolCall (revert + rebobinar chat, opt-in)', () => {
    it('trunca a conversa ANTES da mensagem que contém o tool call', () => {
      const sid = useChatStore.getState().createSession('/test/project')
      useChatStore.getState().addUserMessage('pedido inicial')
      useChatStore.getState().startAssistantMessage()
      useChatStore.getState().addPendingToolCall('tc-anchor', 'edit_file')
      useChatStore.getState().finalizeAssistantMessage()
      useChatStore.getState().addUserMessage('follow-up')

      const ok = useChatStore.getState().rewindToToolCall('tc-anchor')

      expect(ok).toBe(true)
      const session = useChatStore.getState().sessions.get(sid)!
      // A conversa volta a acabar na mensagem do developer que pediu o
      // trabalho — a mensagem do assistant com o call e tudo depois saem.
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].role).toBe('user')
      expect(session.messages[0].content).toBe('pedido inicial')
      expect(useChatStore.getState().conversationHistory.some(m => m.role === 'assistant')).toBe(false)
    })

    it('devolve false sem tocar em nada quando o call não está no transcript', () => {
      const sid = useChatStore.getState().createSession('/test/project')
      useChatStore.getState().addUserMessage('pedido')
      const before = useChatStore.getState().sessions.get(sid)!.messages.length

      expect(useChatStore.getState().rewindToToolCall('tc-inexistente')).toBe(false)
      expect(useChatStore.getState().sessions.get(sid)!.messages).toHaveLength(before)
    })
  })

  describe('cancelamento com diff por decidir', () => {
    // Bug reportado 2026-07-28: o agente pediu autorização de um diff, o user
    // carregou em Stop, e o cartão FICOU com os botões Accept/Reject clicáveis.
    // Carregar em Accept chamava DiffService.acceptDiff — escrevia o ficheiro de
    // um run cancelado, com o modelo já informado de que a edição fora recusada.
    function seedPendingDiff(toolCallId: string) {
      useChatStore.getState().createSession('/work/proj-diff')
      useChatStore.getState().startAssistantMessage()
      useChatStore.getState().addPendingToolCall(toolCallId, 'write_file')
      useChatStore.getState().updateToolCallWithResult(
        toolCallId,
        JSON.stringify({
          type: 'diff',
          path: '/work/proj-diff/ApiClient.ts',
          oldContent: 'a\nb\n',
          newContent: 'a\n',
          isNewFile: false,
        }),
        false,
      )
    }

    function toolCallById(toolCallId: string) {
      const { activeSessionId, sessions } = useChatStore.getState()
      const session = sessions.get(activeSessionId!)
      return session?.messages
        .flatMap(m => m.toolCalls ?? [])
        .find(tc => tc.id === toolCallId)
    }

    it('o Stop marca o diff como recusado — os botões deixam de existir', async () => {
      seedPendingDiff('tc-stop')
      expect(toolCallById('tc-stop')?.diffStatus).toBe('pending')
      expect(useChatStore.getState().pendingDiffs).toHaveLength(1)

      const approval = createDiffApprovalPromise('tc-stop')
      resolveAllPendingDiffApprovals(false)

      // O agente desbloqueia...
      await expect(approval).resolves.toBe(false)
      // ...E a UI passa a dizer o mesmo. É `diffStatus !== 'pending'` que faz o
      // InlineDiff considerar o diff resolvido e esconder os botões; enquanto
      // ficasse 'pending' havia um Accept clicável a escrever no disco.
      expect(toolCallById('tc-stop')?.diffStatus).toBe('denied')
      expect(useChatStore.getState().pendingDiffs).toHaveLength(0)
    })

    it('aprovar tudo NÃO passa pelo descarte (esse caminho escreve mesmo)', async () => {
      seedPendingDiff('tc-approve')
      const approval = createDiffApprovalPromise('tc-approve')

      resolveAllPendingDiffApprovals(true)

      await expect(approval).resolves.toBe(true)
      // approveAllPendingDiffs carimba os estados por sua conta depois de
      // escrever; marcá-lo como recusado aqui apagava uma aprovação real.
      expect(toolCallById('tc-approve')?.diffStatus).toBe('pending')
    })
  })

  describe('aprovação/rejeição por diffResultId (DiffApprovalBar)', () => {
    // A barra só conhece o DiffResult (pendingDiffs) — as variantes ByResultId
    // localizam messageId+toolCallId e delegam nas ações centrais.
    function seedPendingDiff(toolCallId: string, path: string) {
      useChatStore.getState().addPendingToolCall(toolCallId, 'write_file')
      useChatStore.getState().updateToolCallWithResult(
        toolCallId,
        JSON.stringify({
          type: 'diff',
          path,
          oldContent: 'a\nb\n',
          newContent: 'a\n',
          isNewFile: false,
        }),
        false,
      )
    }

    function toolCallById(toolCallId: string) {
      const { activeSessionId, sessions } = useChatStore.getState()
      const session = sessions.get(activeSessionId!)
      return session?.messages
        .flatMap(m => m.toolCalls ?? [])
        .find(tc => tc.id === toolCallId)
    }

    beforeEach(() => {
      useChatStore.getState().createSession('/work/proj-diff')
      useChatStore.getState().startAssistantMessage()
    })

    it('getPendingDiffApprovalToolIds expõe as chaves pendentes', async () => {
      const p1 = createDiffApprovalPromise('tc-ids-1')
      const p2 = createDiffApprovalPromise('tc-ids-2')

      expect(getPendingDiffApprovalToolIds().sort()).toEqual(['tc-ids-1', 'tc-ids-2'])

      resolveDiffApproval('tc-ids-1', true)
      await p1
      expect(getPendingDiffApprovalToolIds()).toEqual(['tc-ids-2'])

      resolveDiffApproval('tc-ids-2', false)
      await p2
      expect(getPendingDiffApprovalToolIds()).toEqual([])
    })

    it('approveDiffByResultId resolve o promise certo, marca approved e limpa pendingDiffs', async () => {
      seedPendingDiff('tc-res-a', '/work/proj-diff/A.ts')
      seedPendingDiff('tc-res-b', '/work/proj-diff/B.ts')
      const approvalA = createDiffApprovalPromise('tc-res-a')
      createDiffApprovalPromise('tc-res-b')

      const diffAId = toolCallById('tc-res-a')!.diffResultId!
      await useChatStore.getState().approveDiffByResultId(diffAId)

      await expect(approvalA).resolves.toBe(true)
      expect(toolCallById('tc-res-a')?.diffStatus).toBe('approved')
      // O diff B fica intocado: pendente na barra E no gate do executor.
      expect(toolCallById('tc-res-b')?.diffStatus).toBe('pending')
      expect(useChatStore.getState().pendingDiffs.map(d => d.id)).toEqual([
        toolCallById('tc-res-b')!.diffResultId,
      ])
      expect(getPendingDiffApprovalToolIds()).toEqual(['tc-res-b'])

      // Cleanup para não deixar promises penduradas
      resolveDiffApproval('tc-res-b', false)
    })

    it('rejectDiffByResultId resolve a false, marca denied e limpa pendingDiffs', async () => {
      seedPendingDiff('tc-rej', '/work/proj-diff/C.ts')
      const approval = createDiffApprovalPromise('tc-rej')

      const diffId = toolCallById('tc-rej')!.diffResultId!
      useChatStore.getState().rejectDiffByResultId(diffId)

      await expect(approval).resolves.toBe(false)
      expect(toolCallById('tc-rej')?.diffStatus).toBe('denied')
      expect(useChatStore.getState().pendingDiffs).toHaveLength(0)
      expect(getPendingDiffApprovalToolIds()).toEqual([])
    })

    it('diffResultId desconhecido é no-op — nada resolve nem muda de estado', async () => {
      seedPendingDiff('tc-noop', '/work/proj-diff/D.ts')
      const approval = createDiffApprovalPromise('tc-noop')

      await useChatStore.getState().approveDiffByResultId('diff-inexistente')
      useChatStore.getState().rejectDiffByResultId('diff-inexistente')

      expect(toolCallById('tc-noop')?.diffStatus).toBe('pending')
      expect(useChatStore.getState().pendingDiffs).toHaveLength(1)
      expect(getPendingDiffApprovalToolIds()).toEqual(['tc-noop'])

      // Cleanup
      resolveDiffApproval('tc-noop', false)
      await expect(approval).resolves.toBe(false)
    })
  })

})

/**
 * O pill de contexto "ia para a frente e recuava" — reportado várias vezes e
 * corrigido três vezes no sítio errado (denominador, sessão lida, fallback).
 *
 * A causa raiz era esta: `lastPromptTokens` tinha DOIS donos com grandezas
 * diferentes. O `addTokenUsage` escreve o tamanho REAL do prompt (a conversa
 * toda); o `addEstimatedTokenUsage` escreve um acumulador que arranca em ZERO
 * a cada run e conta só os deltas desse run. A cada mensagem nova a barra caía
 * de 86% para 2% e voltava a saltar quando o usage real aterrava.
 */
describe('ocupação do contexto: real vs estimativa', () => {
  it('uma estimativa de run novo NÃO baixa a ocupação real', () => {
    const store = useChatStore.getState()
    const sessionId = store.createSession('/test/project')
    useChatStore.setState({ activeSessionId: sessionId, streamingSessionId: sessionId })

    // Turno real: a conversa toda vai a 98K.
    useChatStore.getState().addTokenUsage(98_000, 500, true)
    expect(useChatStore.getState().sessions.get(sessionId)?.lastPromptTokens).toBe(98_000)

    // Mensagem nova: o acumulador do mainDispatch recomeça do zero.
    useChatStore.getState().addEstimatedTokenUsage(2_000, 100, true)
    expect(useChatStore.getState().sessions.get(sessionId)?.lastPromptTokens).toBe(98_000)

    // Estimativa a crescer, ainda abaixo do real — continua sem mexer.
    useChatStore.getState().addEstimatedTokenUsage(40_000, 800, true)
    expect(useChatStore.getState().sessions.get(sessionId)?.lastPromptTokens).toBe(98_000)

    // Acima do real: aí sim, é informação nova.
    useChatStore.getState().addEstimatedTokenUsage(101_000, 900, true)
    expect(useChatStore.getState().sessions.get(sessionId)?.lastPromptTokens).toBe(101_000)
  })

  it('o usage REAL manda sempre, mesmo para baixo (o histórico encolheu)', () => {
    const store = useChatStore.getState()
    const sessionId = store.createSession('/test/project')
    useChatStore.setState({ activeSessionId: sessionId, streamingSessionId: sessionId })

    useChatStore.getState().addTokenUsage(98_000, 500, true)
    // Pós-compactação o provider reporta um prompt mais pequeno — e é verdade.
    useChatStore.getState().addTokenUsage(35_000, 400, true)
    expect(useChatStore.getState().sessions.get(sessionId)?.lastPromptTokens).toBe(35_000)
  })
})
