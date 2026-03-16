import { create } from 'zustand'
import { ChatMessage, ChatSession, CodeBlock, ConversationMessage, SessionSummary, ToolCallDisplay } from '../types/chat'
import DiffService, { DiffResult } from '../services/agent/diffService'
import { sessionService } from '../services/agent/sessionService'
import { usePermissionStore } from './permissionStore'
import { logger } from '../utils/logger'

interface ChatState {
  sessions: Map<string, ChatSession>
  activeSessionId: string | null
  isStreaming: boolean
  isLoadingSession: boolean
  streamingMessageId: string | null
  error: string | null
  conversationHistory: ConversationMessage[]
  currentTurnCount: number
  totalTokensUsed: { input: number; output: number }
  pendingDiffs: DiffResult[]
}

interface ChatActions {
  createSession: (projectPath: string) => string
  getActiveSession: () => ChatSession | null
  setActiveSession: (sessionId: string) => void
  addUserMessage: (content: string) => string
  addSystemMessage: (content: string) => void
  startAssistantMessage: () => string
  finalizeAssistantMessage: () => void
  addCodeBlockToMessage: (messageId: string, block: CodeBlock) => void
  updateCodeBlockStatus: (messageId: string, blockId: string, status: 'applied' | 'rejected') => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  clearSession: (sessionId: string) => void
  // Streaming actions
  appendTextDelta: (delta: string) => void
  appendReasoningDelta: (delta: string) => void
  // Reasoning toggle
  toggleReasoning: (messageId: string) => void
  // Tool call actions (pending -> start -> result)
  addPendingToolCall: (toolId: string, toolName: string) => void
  updateToolCallWithArgs: (toolId: string, args: Record<string, unknown>) => void
  updateToolCallWithResult: (toolId: string, result: string, isError: boolean) => void
  // Inline diff actions
  updateToolCallDiffStatus: (messageId: string, toolCallId: string, status: 'approved' | 'denied') => void
  // Sync diff status by DiffResult ID (used by GeneratingView)
  syncDiffStatusByResultId: (diffResultId: string, status: 'approved' | 'denied') => void
  updateConversationHistory: (messages: ConversationMessage[]) => void
  incrementTurnCount: () => void
  addTokenUsage: (input: number, output: number) => void
  // Diff actions
  addPendingDiff: (diff: DiffResult) => void
  removePendingDiff: (diffId: string) => void
  clearPendingDiffs: () => void
  approveAllPendingDiffs: () => Promise<void>
  // Persistence actions
  saveSessionToDisk: () => Promise<void>
  loadSessionFromDisk: (projectPath: string, sessionId: string) => Promise<void>
  restoreLastSession: (projectPath: string) => Promise<boolean>
  listProjectSessions: (projectPath: string) => Promise<SessionSummary[]>
  createNewSession: (projectPath: string) => Promise<string>
  switchSession: (projectPath: string, sessionId: string) => Promise<void>
  deleteSessionFromDisk: (projectPath: string, sessionId: string) => Promise<void>
  initPersistence: (projectPath: string) => Promise<void>
  cleanupOnExit: (projectPath: string) => Promise<void>
}

let idCounter = 0
function generateId(prefix: string): string {
  idCounter++
  return `${prefix}-${Date.now()}-${idCounter}`
}

// Debounce helper
let saveTimeout: ReturnType<typeof setTimeout> | null = null
function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    sessionService.markDirty()
    sessionService.flushNow().catch(err =>
      logger.error('chat', 'Auto-save failed:', err)
    )
  }, 2000)
}

// Token buffering for streaming performance (50ms flush)
let textBuffer = ''
let reasoningBuffer = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function appendTextDeltaBuffered(delta: string) {
  textBuffer += delta
  scheduleFlush()
}

export function appendReasoningDeltaBuffered(delta: string) {
  reasoningBuffer += delta
  scheduleFlush()
}

function scheduleFlush() {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const text = textBuffer
      const reasoning = reasoningBuffer
      textBuffer = ''
      reasoningBuffer = ''
      flushTimer = null

      const store = useChatStore.getState()
      if (text) store.appendTextDelta(text)
      if (reasoning) store.appendReasoningDelta(reasoning)
    }, 50)
  }
}

export function flushBufferedDeltas() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const text = textBuffer
  const reasoning = reasoningBuffer
  textBuffer = ''
  reasoningBuffer = ''

  const store = useChatStore.getState()
  if (text) store.appendTextDelta(text)
  if (reasoning) store.appendReasoningDelta(reasoning)
}

function rebuildConversationHistory(messages: ChatMessage[]): ConversationMessage[] {
  const history: ConversationMessage[] = []

  for (const msg of messages) {
    // System messages are UI-only status lines (e.g. "Installing dependencies...")
    // — never send them to the LLM.
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      history.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls?.length) {
        // Assistant message with tool calls
        history.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
          })),
        })

        // Add tool results (sanitize diff JSON to avoid bloating LLM context)
        for (const tc of msg.toolCalls) {
          if (tc.status !== 'running' && tc.result !== undefined) {
            let resultContent = tc.result || ''

            // Sanitize diff JSON: send short summary instead of full file content
            try {
              const parsed = JSON.parse(resultContent)
              if (parsed.type === 'diff') {
                resultContent = `File ${parsed.isNewFile ? 'created' : 'updated'}: ${parsed.path}`
              }
            } catch {
              // Not JSON, use as-is
            }

            const isTruncated = resultContent.endsWith('...')
            history.push({
              role: 'tool',
              content: isTruncated
                ? `${resultContent}\n[Note: result was truncated from a previous session]`
                : resultContent,
              tool_call_id: tc.id,
            })
          }
        }
      } else {
        history.push({ role: 'assistant', content: msg.content })
      }
    } else {
      history.push({ role: msg.role, content: msg.content })
    }
  }

  return history
}

export const useChatStore = create<ChatState & ChatActions>()((set, get) => {
  // Wire sessionService getters
  sessionService.setSessionGetter(() => get().getActiveSession())
  sessionService.setTokenUsageGetter(() => ({
    input: get().totalTokensUsed.input,
    output: get().totalTokensUsed.output,
    turns: get().currentTurnCount,
  }))

  return {
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

    createSession: (projectPath: string) => {
      const sessionId = generateId('session')
      const now = Date.now()
      const session: ChatSession = {
        id: sessionId,
        projectPath,
        messages: [],
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      }

      set(state => {
        const sessions = new Map(state.sessions)
        sessions.set(sessionId, session)
        return {
          sessions,
          activeSessionId: sessionId,
          conversationHistory: [],
          currentTurnCount: 0,
          totalTokensUsed: { input: 0, output: 0 },
        }
      })

      return sessionId
    },

    getActiveSession: () => {
      const { sessions, activeSessionId } = get()
      if (!activeSessionId) return null
      return sessions.get(activeSessionId) || null
    },

    setActiveSession: (sessionId: string) => {
      set({ activeSessionId: sessionId })
    },

    addUserMessage: (content: string) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'user',
        content,
        timestamp: Date.now(),
      }

      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const updatedSession: ChatSession = {
          ...session,
          messages: [...session.messages, message],
          status: 'running',
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return { sessions: updatedSessions }
      })

      debouncedSave()
      return messageId
    },

    addSystemMessage: (content: string) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content,
        timestamp: Date.now(),
      }

      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const updatedSession: ChatSession = {
          ...session,
          messages: [...session.messages, message],
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return { sessions: updatedSessions }
      })
    },

    startAssistantMessage: () => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        codeBlocks: [],
        toolCalls: [],
        isStreaming: true,
      }

      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const updatedSession: ChatSession = {
          ...session,
          messages: [...session.messages, message],
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return {
          sessions: updatedSessions,
          isStreaming: true,
          streamingMessageId: messageId,
        }
      })

      return messageId
    },

    // === Streaming actions (buffered for performance) ===

    appendTextDelta: (delta: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (msg) {
        msg.content = msg.content + delta
        session.updatedAt = Date.now()
      }

      set({ sessions })
    },

    appendReasoningDelta: (delta: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (msg) {
        msg.reasoningContent = (msg.reasoningContent || '') + delta
        session.updatedAt = Date.now()
      }

      set({ sessions })
    },

    toggleReasoning: (messageId: string) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          return { ...msg, isReasoningVisible: !msg.isReasoningVisible }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages })

        return { sessions: updatedSessions }
      })
    },

    addPendingToolCall: (toolId: string, toolName: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const toolCall: ToolCallDisplay = {
        id: toolId,
        toolName,
        input: {},
        status: 'running',
        timestamp: Date.now(),
      }

      const messages = session.messages.map(msg => {
        if (msg.id !== streamingMessageId) return msg
        return {
          ...msg,
          toolCalls: [...(msg.toolCalls || []), toolCall],
        }
      })

      const updatedSessions = new Map(sessions)
      updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

      set({ sessions: updatedSessions })
    },

    updateToolCallWithArgs: (toolId: string, args: Record<string, unknown>) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const messages = session.messages.map(msg => {
        if (msg.id !== streamingMessageId) return msg
        const toolCalls = [...(msg.toolCalls || [])]
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          if (toolCalls[i].id === toolId) {
            toolCalls[i] = { ...toolCalls[i], input: args }
            break
          }
        }
        return { ...msg, toolCalls }
      })

      const updatedSessions = new Map(sessions)
      updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

      set({ sessions: updatedSessions })
    },

    updateToolCallWithResult: (toolId: string, result: string, isError: boolean) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      let newDiff: DiffResult | null = null

      const messages = session.messages.map(msg => {
        if (msg.id !== streamingMessageId) return msg
        const toolCalls = [...(msg.toolCalls || [])]
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          if (toolCalls[i].id === toolId) {
            // Check if result is diff JSON (from write_file / edit_file)
            let diffOldContent: string | undefined
            let diffNewContent: string | undefined
            let isNewFile: boolean | undefined
            let diffStatus: 'pending' | 'approved' | 'denied' | undefined
            let diffResultId: string | undefined

            try {
              const parsed = JSON.parse(result)
              if (parsed.type === 'diff') {
                diffOldContent = parsed.oldContent
                diffNewContent = parsed.newContent
                isNewFile = parsed.isNewFile
                diffStatus = 'pending'

                // Create DiffResult for DiffService + GeneratingView
                const id = crypto.randomUUID()
                diffResultId = id
                newDiff = {
                  id,
                  filePath: parsed.path,
                  originalContent: parsed.oldContent || '',
                  newContent: parsed.newContent || '',
                  isNewFile: parsed.isNewFile || false,
                  status: 'pending',
                }
              }
            } catch {
              // Not diff JSON, ignore
            }

            toolCalls[i] = {
              ...toolCalls[i],
              result,
              isError,
              status: isError ? 'failed' : 'completed',
              ...(diffOldContent !== undefined && { diffOldContent }),
              ...(diffNewContent !== undefined && { diffNewContent }),
              ...(isNewFile !== undefined && { isNewFile }),
              ...(diffStatus !== undefined && { diffStatus }),
              ...(diffResultId !== undefined && { diffResultId }),
            }
            break
          }
        }
        return { ...msg, toolCalls }
      })

      const updatedSessions = new Map(sessions)
      updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

      // If a diff was created, register with DiffService and add to pendingDiffs
      if (newDiff) {
        DiffService.getInstance().registerDiff(newDiff)
        set({
          sessions: updatedSessions,
          pendingDiffs: [...get().pendingDiffs, newDiff],
        })
      } else {
        set({ sessions: updatedSessions })
      }
    },

    updateToolCallDiffStatus: (messageId: string, toolCallId: string, status: 'approved' | 'denied') => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          const toolCalls = (msg.toolCalls || []).map(tc =>
            tc.id === toolCallId ? { ...tc, diffStatus: status } : tc
          )
          return { ...msg, toolCalls }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return { sessions: updatedSessions }
      })
    },

    syncDiffStatusByResultId: (diffResultId: string, status: 'approved' | 'denied') => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        let changed = false
        const messages = session.messages.map(msg => {
          const toolCalls = (msg.toolCalls || []).map(tc => {
            if (tc.diffResultId === diffResultId && tc.diffStatus === 'pending') {
              changed = true
              return { ...tc, diffStatus: status }
            }
            return tc
          })
          return changed ? { ...msg, toolCalls } : msg
        })

        if (!changed) return state

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return { sessions: updatedSessions }
      })
    },

    finalizeAssistantMessage: () => {
      set(state => {
        const { activeSessionId, streamingMessageId, sessions } = state
        if (!activeSessionId || !streamingMessageId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg =>
          msg.id === streamingMessageId
            ? { ...msg, isStreaming: false }
            : msg
        )

        const updatedSession: ChatSession = {
          ...session,
          messages,
          status: 'idle',
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return {
          sessions: updatedSessions,
          isStreaming: false,
          streamingMessageId: null,
        }
      })

      debouncedSave()
    },

    addCodeBlockToMessage: (messageId: string, block: CodeBlock) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          return {
            ...msg,
            codeBlocks: [...(msg.codeBlocks || []), block],
          }
        })

        const updatedSession: ChatSession = {
          ...session,
          messages,
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return { sessions: updatedSessions }
      })
    },

    updateCodeBlockStatus: (messageId: string, blockId: string, status: 'applied' | 'rejected') => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          return {
            ...msg,
            codeBlocks: (msg.codeBlocks || []).map(cb =>
              cb.id === blockId ? { ...cb, status } : cb
            ),
          }
        })

        const updatedSession: ChatSession = {
          ...session,
          messages,
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return { sessions: updatedSessions }
      })
    },

    setStreaming: (streaming: boolean) => {
      set({ isStreaming: streaming })
    },

    setError: (error: string | null) => {
      set({ error })
    },

    clearSession: (sessionId: string) => {
      // Clear module-level debounce timer to prevent stale writes
      if (saveTimeout) {
        clearTimeout(saveTimeout)
        saveTimeout = null
      }
      set(state => {
        const sessions = new Map(state.sessions)
        sessions.delete(sessionId)

        const activeSessionId = state.activeSessionId === sessionId
          ? null
          : state.activeSessionId

        return { sessions, activeSessionId, conversationHistory: [], currentTurnCount: 0 }
      })
    },

    updateConversationHistory: (messages: ConversationMessage[]) => {
      set({ conversationHistory: messages })
    },

    incrementTurnCount: () => {
      set(state => ({ currentTurnCount: state.currentTurnCount + 1 }))
    },

    addTokenUsage: (input: number, output: number) => {
      set(state => ({
        totalTokensUsed: {
          input: state.totalTokensUsed.input + input,
          output: state.totalTokensUsed.output + output,
        }
      }))
    },

    // === Diff actions ===

    addPendingDiff: (diff: DiffResult) => {
      set(state => ({
        pendingDiffs: [...state.pendingDiffs, diff]
      }))
    },

    removePendingDiff: (diffId: string) => {
      set(state => ({
        pendingDiffs: state.pendingDiffs.filter(d => d.id !== diffId)
      }))
    },

    clearPendingDiffs: () => {
      set({ pendingDiffs: [] })
    },

    approveAllPendingDiffs: async () => {
      // 1. Accept all diffs in DiffService (writes files)
      try {
        await DiffService.getInstance().acceptAllDiffs()
      } catch (err) {
        logger.error('Failed to accept all diffs:', String(err))
      }

      // 2. Update ALL pending tool calls in a single state update
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return { pendingDiffs: [] }

        const session = sessions.get(activeSessionId)
        if (!session) return { pendingDiffs: [] }

        const messages = session.messages.map(msg => {
          const toolCalls = msg.toolCalls
          if (!toolCalls?.length) return msg

          let msgChanged = false
          const updatedToolCalls = toolCalls.map(tc => {
            if (tc.diffStatus === 'pending') {
              msgChanged = true
              return { ...tc, diffStatus: 'approved' as const }
            }
            return tc
          })

          return msgChanged ? { ...msg, toolCalls: updatedToolCalls } : msg
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return { sessions: updatedSessions, pendingDiffs: [] }
      })
    },

    // === Persistence actions ===

    initPersistence: async (projectPath: string) => {
      await sessionService.init(projectPath)
      sessionService.startAutoSave(30000)
    },

    saveSessionToDisk: async () => {
      const state = get()
      const session = state.getActiveSession()
      if (session) {
        await sessionService.saveSession(session, {
          input: state.totalTokensUsed.input,
          output: state.totalTokensUsed.output,
          turns: state.currentTurnCount,
        })
      }
    },

    loadSessionFromDisk: async (projectPath: string, sessionId: string) => {
      set({ isLoadingSession: true })
      try {
        const session = await sessionService.loadSession(projectPath, sessionId)
        if (!session) return

        // Strip system messages — they're ephemeral status updates
        // (e.g. "Installing dependencies...") that shouldn't reappear.
        session.messages = session.messages.filter(m => m.role !== 'system')

        const conversationHistory = rebuildConversationHistory(session.messages)

        set(() => {
          // Only keep the loaded session in memory to avoid unbounded growth
          const sessions = new Map<string, ChatSession>()
          sessions.set(session.id, session)
          return {
            sessions,
            activeSessionId: session.id,
            conversationHistory,
            currentTurnCount: 0,
            totalTokensUsed: { input: 0, output: 0 },
            pendingDiffs: [],
          }
        })

        await sessionService.setActiveSessionId(projectPath, sessionId)
      } finally {
        set({ isLoadingSession: false })
      }
    },

    restoreLastSession: async (projectPath: string) => {
      set({ isLoadingSession: true })
      try {
        await sessionService.init(projectPath)
        const activeId = await sessionService.getActiveSessionId(projectPath)
        if (!activeId) return false

        const session = await sessionService.loadSession(projectPath, activeId)
        if (!session || session.messages.length === 0) return false

        // Strip system messages — they're ephemeral status updates
        session.messages = session.messages.filter(m => m.role !== 'system')
        if (session.messages.length === 0) return false

        const conversationHistory = rebuildConversationHistory(session.messages)

        set(() => {
          const sessions = new Map<string, ChatSession>()
          sessions.set(session.id, session)
          return {
            sessions,
            activeSessionId: session.id,
            conversationHistory,
            currentTurnCount: 0,
            totalTokensUsed: { input: 0, output: 0 },
            pendingDiffs: [],
          }
        })

        sessionService.startAutoSave(30000)
        return true
      } catch (error) {
        logger.error('chat', 'Failed to restore last session:', error)
        return false
      } finally {
        set({ isLoadingSession: false })
      }
    },

    listProjectSessions: async (projectPath: string) => {
      return sessionService.listSessions(projectPath)
    },

    createNewSession: async (projectPath: string) => {
      // Save current session before creating new one
      const state = get()
      const currentSession = state.getActiveSession()
      if (currentSession && currentSession.messages.length > 0) {
        await sessionService.saveSession(currentSession, {
          input: state.totalTokensUsed.input,
          output: state.totalTokensUsed.output,
          turns: state.currentTurnCount,
        })
      }

      // Reset tool permission auto-approve for the new session
      usePermissionStore.getState().resetAutoApprove()

      // Ensure persistence is initialized (covers case where restoreLastSession returned false)
      await sessionService.init(projectPath)
      const session = await sessionService.createSession(projectPath)

      set(() => {
        // Only keep the new session in memory
        const sessions = new Map<string, ChatSession>()
        sessions.set(session.id, session)
        return {
          sessions,
          activeSessionId: session.id,
          conversationHistory: [],
          currentTurnCount: 0,
          totalTokensUsed: { input: 0, output: 0 },
          pendingDiffs: [],
        }
      })

      sessionService.startAutoSave(30000)
      return session.id
    },

    switchSession: async (projectPath: string, sessionId: string) => {
      set({ isLoadingSession: true })
      try {
        // Save current session before switching
        const state = get()
        const currentSession = state.getActiveSession()
        if (currentSession && currentSession.messages.length > 0) {
          await sessionService.saveSession(currentSession, {
            input: state.totalTokensUsed.input,
            output: state.totalTokensUsed.output,
            turns: state.currentTurnCount,
          })
        }

        // Reset tool permission auto-approve for the new session
        usePermissionStore.getState().resetAutoApprove()

        await get().loadSessionFromDisk(projectPath, sessionId)
      } finally {
        set({ isLoadingSession: false })
      }
    },

    deleteSessionFromDisk: async (projectPath: string, sessionId: string) => {
      const state = get()

      // If deleting the active session, clear it from memory
      if (state.activeSessionId === sessionId) {
        // Clear module-level debounce timer
        if (saveTimeout) {
          clearTimeout(saveTimeout)
          saveTimeout = null
        }

        set(() => {
          const sessions = new Map<string, ChatSession>()
          return {
            sessions,
            activeSessionId: null,
            conversationHistory: [],
            currentTurnCount: 0,
            totalTokensUsed: { input: 0, output: 0 },
            pendingDiffs: [],
          }
        })
      } else {
        // Just remove from in-memory map if it happens to be there
        set(s => {
          const sessions = new Map(s.sessions)
          sessions.delete(sessionId)
          return { sessions }
        })
      }

      // Delete from disk
      await sessionService.deleteSession(projectPath, sessionId)
    },

    cleanupOnExit: async (projectPath: string) => {
      // Save current session with token usage
      const state = get()
      const session = state.getActiveSession()
      if (session) {
        await sessionService.saveSession(session, {
          input: state.totalTokensUsed.input,
          output: state.totalTokensUsed.output,
          turns: state.currentTurnCount,
        })
      }

      // Stop auto-save
      sessionService.stopAutoSave()

      // Clean up empty sessions
      await sessionService.cleanupEmptySessions(projectPath)
    },
  }
})
