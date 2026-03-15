import { create } from 'zustand'
import { ChatMessage, ChatSession, CodeBlock, ConversationMessage, SessionSummary, ToolCallDisplay } from '../types/chat'
import { DiffResult } from '../services/agent/diffService'
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
  startAssistantMessage: () => string
  appendToAssistantMessage: (token: string) => void
  finalizeAssistantMessage: () => void
  addCodeBlockToMessage: (messageId: string, block: CodeBlock) => void
  updateCodeBlockStatus: (messageId: string, blockId: string, status: 'applied' | 'rejected') => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  clearSession: (sessionId: string) => void
  // Agentic loop actions
  appendToolCallToMessage: (messageId: string, toolName: string, input: Record<string, unknown>) => void
  appendToolResultToMessage: (messageId: string, toolName: string, result: string, isError: boolean) => void
  updateConversationHistory: (messages: ConversationMessage[]) => void
  incrementTurnCount: () => void
  addTokenUsage: (input: number, output: number) => void
  // Diff actions
  addPendingDiff: (diff: DiffResult) => void
  removePendingDiff: (diffId: string) => void
  clearPendingDiffs: () => void
  // Persistence actions
  saveSessionToDisk: () => Promise<void>
  loadSessionFromDisk: (projectPath: string, sessionId: string) => Promise<void>
  restoreLastSession: (projectPath: string) => Promise<boolean>
  listProjectSessions: (projectPath: string) => Promise<SessionSummary[]>
  createNewSession: (projectPath: string) => Promise<string>
  switchSession: (projectPath: string, sessionId: string) => Promise<void>
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

function rebuildConversationHistory(messages: ChatMessage[]): ConversationMessage[] {
  const history: ConversationMessage[] = []

  for (const msg of messages) {
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

        // Add tool results
        for (const tc of msg.toolCalls) {
          if (tc.status !== 'running' && tc.result !== undefined) {
            const isTruncated = tc.result?.endsWith('...')
            history.push({
              role: 'tool',
              content: isTruncated
                ? `${tc.result}\n[Note: result was truncated from a previous session]`
                : (tc.result || ''),
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

    appendToAssistantMessage: (token: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      // Mutate in place to avoid O(n) Map copy per token
      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (msg) {
        msg.content = msg.content + token
        session.updatedAt = Date.now()
      }

      // Trigger re-render with minimal new reference
      set({ sessions })
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

    // === Agentic loop actions ===

    appendToolCallToMessage: (messageId: string, toolName: string, input: Record<string, unknown>) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const toolCall: ToolCallDisplay = {
          id: generateId('tc'),
          toolName,
          input,
          status: 'running',
          timestamp: Date.now(),
        }

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          return {
            ...msg,
            toolCalls: [...(msg.toolCalls || []), toolCall],
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

    appendToolResultToMessage: (messageId: string, toolName: string, result: string, isError: boolean) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg

          const toolCalls = [...(msg.toolCalls || [])]
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].toolName === toolName && toolCalls[i].status === 'running') {
              toolCalls[i] = {
                ...toolCalls[i],
                result,
                isError,
                status: isError ? 'failed' : 'completed',
              }
              break
            }
          }

          return { ...msg, toolCalls }
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
