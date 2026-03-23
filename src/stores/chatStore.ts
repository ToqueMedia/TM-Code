import { create } from 'zustand'
import { ChatMessage, ChatMessageCard, ChatSession, CodeBlock, ConversationMessage, SessionSummary, ToolCallDisplay } from '../types/chat'
import DiffService, { DiffResult } from '../services/agent/diffService'
import { sessionService } from '../services/agent/sessionService'
import CheckpointService from '../services/agent/checkpointService'
import { useCheckpointStore } from './checkpointStore'
import { usePermissionStore } from './permissionStore'
import { logger } from '../utils/logger'

interface ChatState {
  sessions: Map<string, ChatSession>
  activeSessionId: string | null
  isStreaming: boolean
  isLoadingSession: boolean
  streamingMessageId: string | null
  /** Incremented on each streaming flush — triggers re-renders for the active message */
  streamingVersion: number
  error: string | null
  conversationHistory: ConversationMessage[]
  currentTurnCount: number
  totalTokensUsed: { input: number; output: number }
  pendingDiffs: DiffResult[]
  /** Draft prompt text — shared across PromptBar instances (chat + preview) */
  draftInput: string
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
  updateToolCallProgress: (toolId: string, progressText: string) => void
  // Inline diff actions (centralized — handle DiffService + store + agent unblock atomically)
  approveDiff: (messageId: string, toolCallId: string, diffResultId: string | undefined) => Promise<void>
  rejectDiff: (messageId: string, toolCallId: string, diffResultId: string | undefined) => void
  approveAllPendingDiffs: () => Promise<void>
  // Low-level diff status (used internally / by GeneratingView)
  updateToolCallDiffStatus: (messageId: string, toolCallId: string, status: 'approved' | 'denied') => void
  syncDiffStatusByResultId: (diffResultId: string, status: 'approved' | 'denied') => void
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
  deleteSessionFromDisk: (projectPath: string, sessionId: string) => Promise<void>
  initPersistence: (projectPath: string) => Promise<void>
  cleanupOnExit: (projectPath: string) => Promise<void>
  setDraftInput: (value: string) => void
  clearAllSessions: () => void
  // Card messages (plan approval, todo list)
  addCardMessage: (type: ChatMessageCard['type'], projectPath: string) => void
  updateCardStatus: (messageId: string, status: ChatMessageCard['status']) => void
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

// === Diff approval promises ===
// Module-level map: toolCallId → resolve callback
// Used to make the agent wait until the user approves/rejects a file change.
const pendingDiffApprovals = new Map<string, (approved: boolean) => void>()

export async function createDiffApprovalPromise(toolCallId: string): Promise<boolean> {
  // If auto-approve diffs is enabled (user clicked "Accept All" earlier),
  // accept the diff immediately without blocking the agent.
  if (usePermissionStore.getState().autoApproveDiffs) {
    const session = useChatStore.getState().getActiveSession()
    if (session) {
      // Find the tool call to get its diffResultId (set by updateToolCallWithResult)
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const tc = session.messages[i].toolCalls?.find(t => t.id === toolCallId)
        if (tc?.diffResultId) {
          // Write the file via DiffService — AWAIT to ensure file is written
          // before the agent continues (may read the file in the next turn)
          try {
            await DiffService.getInstance().acceptDiff(tc.diffResultId)
          } catch (err) {
            logger.error('chat', 'Auto-approve acceptDiff failed:', String(err))
          }
          // Update store: mark as approved and remove from pendingDiffs
          useChatStore.getState().syncDiffStatusByResultId(tc.diffResultId, 'approved')
          useChatStore.getState().removePendingDiff(tc.diffResultId)
          break
        }
      }
    }
    return true
  }

  return new Promise(resolve => {
    pendingDiffApprovals.set(toolCallId, resolve)
  })
}

export function resolveDiffApproval(toolCallId: string, approved: boolean) {
  const resolve = pendingDiffApprovals.get(toolCallId)
  if (resolve) {
    resolve(approved)
    pendingDiffApprovals.delete(toolCallId)
  }
}

export function resolveAllPendingDiffApprovals(approved: boolean) {
  for (const [, resolve] of pendingDiffApprovals) {
    resolve(approved)
  }
  pendingDiffApprovals.clear()
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

// Per-result truncation for very large tool outputs (e.g. read_file on huge files)
const MAX_TOOL_RESULT_CHARS = 4000

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

        for (const tc of msg.toolCalls) {
          // Orphan tool call: agent was cancelled mid-execution.
          // Must still emit a tool result — the API rejects assistant messages
          // with tool_calls that lack matching tool results.
          if (tc.status === 'running' || tc.result === undefined) {
            history.push({
              role: 'tool',
              content: 'Tool call was interrupted.',
              tool_call_id: tc.id,
            })
            continue
          }

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

          // Truncate large tool results to prevent context overflow
          if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
            resultContent = resultContent.slice(0, MAX_TOOL_RESULT_CHARS) + '\n[... truncated]'
          }

          history.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: tc.id,
          })
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
    streamingVersion: 0,
    error: null,
    conversationHistory: [],
    currentTurnCount: 0,
    totalTokensUsed: { input: 0, output: 0 },
    pendingDiffs: [],
    draftInput: '',

    setDraftInput: (value: string) => set({ draftInput: value }),

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
        contentBlocks: [],
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
    //
    // IMPORTANT — INTENTIONAL MUTATION PATTERN:
    // These actions mutate message/session objects IN PLACE instead of creating
    // immutable copies. This violates Zustand's immutability contract but avoids
    // allocating new Map/session/messages arrays on every token (~20-50 per second).
    //
    // This works because:
    //   1. `streamingVersion` (a plain counter) is the ONLY selector that changes,
    //      forcing ChatView/ChatPanel to re-render.
    //   2. MessageBubble's custom `memo` comparator returns `false` (always re-render)
    //      when `isStreaming` is true.
    //
    // WARNING: Any new subscriber that does reference-equality checks on `sessions`
    // or individual session objects will NOT detect streaming content changes.
    // Always use `streamingVersion` as the reactivity trigger for streaming data.

    appendTextDelta: (delta: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (msg) {
        // Finalize reasoning timing when first text arrives
        if (msg.reasoningStartedAt && !msg.reasoningDurationMs) {
          msg.reasoningDurationMs = Date.now() - msg.reasoningStartedAt
        }
        msg.content = msg.content + delta
        // Maintain interleaved contentBlocks: append to last text block or create new one
        const blocks = msg.contentBlocks || (msg.contentBlocks = [])
        const last = blocks[blocks.length - 1]
        if (last && last.type === 'text') {
          last.text += delta
        } else {
          blocks.push({ type: 'text', text: delta })
        }
        session.updatedAt = Date.now()
      }

      set(s => ({ streamingVersion: s.streamingVersion + 1 }))
    },

    appendReasoningDelta: (delta: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (msg) {
        // Track when reasoning started
        if (!msg.reasoningStartedAt) {
          msg.reasoningStartedAt = Date.now()
        }
        msg.reasoningContent = (msg.reasoningContent || '') + delta
        session.updatedAt = Date.now()
      }

      set(s => ({ streamingVersion: s.streamingVersion + 1 }))
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
        // Finalize reasoning timing if tool call arrives before text
        const reasoningDurationMs = (msg.reasoningStartedAt && !msg.reasoningDurationMs)
          ? Date.now() - msg.reasoningStartedAt
          : msg.reasoningDurationMs
        const contentBlocks = [...(msg.contentBlocks || [])]
        contentBlocks.push({ type: 'tool_call', toolCallId: toolId })
        return {
          ...msg,
          toolCalls: [...(msg.toolCalls || []), toolCall],
          contentBlocks,
          ...(reasoningDurationMs !== undefined && { reasoningDurationMs }),
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

    updateToolCallProgress: (toolId: string, progressText: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (!msg) return

      const tc = msg.toolCalls?.find(t => t.id === toolId)
      if (tc) {
        // Mutate in place (same pattern as streaming text deltas for performance)
        tc.progressText = progressText
        session.updatedAt = Date.now()
      }

      set(s => ({ streamingVersion: s.streamingVersion + 1 }))
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
                  toolCallId: toolId,
                  toolName: toolCalls[i].toolName,
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

    // === Centralized diff approve/reject ===
    // These handle the ENTIRE flow atomically: DiffService → store update → agent unblock

    approveDiff: async (messageId: string, toolCallId: string, diffResultId: string | undefined) => {
      // 1. Write file via DiffService (non-blocking on failure)
      if (diffResultId) {
        try {
          await DiffService.getInstance().acceptDiff(diffResultId)
        } catch (err) {
          logger.error('chat', 'DiffService.acceptDiff failed:', String(err))
        }
      }

      // 2. Atomic state update: set diffStatus + remove from pendingDiffs
      set(state => {
        const { activeSessionId, sessions, pendingDiffs } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          const toolCalls = (msg.toolCalls || []).map(tc =>
            tc.id === toolCallId ? { ...tc, diffStatus: 'approved' as const } : tc
          )
          return { ...msg, toolCalls }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return {
          sessions: updatedSessions,
          pendingDiffs: diffResultId ? pendingDiffs.filter(d => d.id !== diffResultId) : pendingDiffs,
        }
      })

      // 3. Unblock agent
      resolveDiffApproval(toolCallId, true)
    },

    rejectDiff: (messageId: string, toolCallId: string, diffResultId: string | undefined) => {
      // 1. Reject in DiffService
      if (diffResultId) {
        DiffService.getInstance().rejectDiff(diffResultId)
      }

      // 2. Atomic state update: set diffStatus + remove from pendingDiffs
      set(state => {
        const { activeSessionId, sessions, pendingDiffs } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          const toolCalls = (msg.toolCalls || []).map(tc =>
            tc.id === toolCallId ? { ...tc, diffStatus: 'denied' as const } : tc
          )
          return { ...msg, toolCalls }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return {
          sessions: updatedSessions,
          pendingDiffs: diffResultId ? pendingDiffs.filter(d => d.id !== diffResultId) : pendingDiffs,
        }
      })

      // 3. Unblock agent (rejected)
      resolveDiffApproval(toolCallId, false)
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
      let finalMessages: ChatMessage[] | null = null

      set(state => {
        const { activeSessionId, streamingMessageId, sessions } = state
        if (!activeSessionId || !streamingMessageId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== streamingMessageId) return msg
          // Finalize reasoning duration if still open
          const reasoningDurationMs = (msg.reasoningStartedAt && !msg.reasoningDurationMs)
            ? Date.now() - msg.reasoningStartedAt
            : msg.reasoningDurationMs
          return {
            ...msg,
            isStreaming: false,
            // Auto-collapse reasoning when streaming ends
            isReasoningVisible: false,
            ...(reasoningDurationMs !== undefined && { reasoningDurationMs }),
          }
        })

        finalMessages = messages

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

      // Rebuild conversation history outside set() — avoids blocking
      // render with JSON parsing and string processing on large sessions.
      if (finalMessages) {
        const conversationHistory = rebuildConversationHistory(finalMessages)
        set({ conversationHistory })
      }

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

      // 1b. Resolve all pending approval promises (unblocks agent)
      resolveAllPendingDiffApprovals(true)

      // 1c. Enable auto-approve for ALL future approvals in this session
      // (both tool permissions and file diffs — user expects single "Accept All")
      const permStore = usePermissionStore.getState()
      permStore.setAutoApproveDiffs(true)
      usePermissionStore.setState({ autoApproveAll: true })

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

        // Strip ephemeral system messages (e.g. "Installing dependencies...")
        // but KEEP card messages (plan_approval, todo_list) which carry actionable state.
        session.messages = session.messages.filter(m => m.role !== 'system' || m.card)

        // Rebuild contentBlocks for legacy messages that don't have them
        for (const msg of session.messages) {
          if (msg.role === 'assistant' && !msg.contentBlocks?.length && msg.toolCalls?.length) {
            // Message has tool calls but no contentBlocks — reconstruct
            const blocks: Array<{ type: 'text'; text: string } | { type: 'tool_call'; toolCallId: string }> = []
            // Put all text as a single block before tool calls
            if (msg.content) {
              blocks.push({ type: 'text', text: msg.content })
            }
            // Then all tool calls
            for (const tc of msg.toolCalls) {
              blocks.push({ type: 'tool_call', toolCallId: tc.id })
            }
            msg.contentBlocks = blocks
          }
        }

        const conversationHistory = rebuildConversationHistory(session.messages)

        // Initialize checkpoints for the loaded session
        await CheckpointService.getInstance().initSession(projectPath, sessionId)
        useCheckpointStore.getState().syncFromService()

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

        // Strip ephemeral system messages but keep card messages
        session.messages = session.messages.filter(m => m.role !== 'system' || m.card)
        if (session.messages.length === 0) return false

        const conversationHistory = rebuildConversationHistory(session.messages)

        // Initialize checkpoint service for this restored session
        await CheckpointService.getInstance().initSession(projectPath, session.id)
        useCheckpointStore.getState().syncFromService()

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

      // Initialize checkpoint service for this session
      await CheckpointService.getInstance().initSession(projectPath, session.id)
      useCheckpointStore.getState().clear()

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

        // loadSessionFromDisk already initializes checkpoints for the session
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

      // Clean up checkpoint data for this session
      await CheckpointService.getInstance().deleteSessionCheckpoints(projectPath, sessionId)
      if (state.activeSessionId === sessionId) {
        useCheckpointStore.getState().clear()
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

      // Flush pending checkpoint data to disk before exit
      await CheckpointService.getInstance().flushPersist()

      // Stop auto-save
      sessionService.stopAutoSave()

      // Clean up empty sessions
      await sessionService.cleanupEmptySessions(projectPath)
    },

    clearAllSessions: () => {
      // Clear module-level debounce timer to prevent stale writes
      if (saveTimeout) {
        clearTimeout(saveTimeout)
        saveTimeout = null
      }
      set({
        sessions: new Map(),
        activeSessionId: null,
        conversationHistory: [],
        isStreaming: false,
        streamingMessageId: null,
        currentTurnCount: 0,
        totalTokensUsed: { input: 0, output: 0 },
        pendingDiffs: [],
        draftInput: '',
      })
    },

    // === Card messages (plan approval, todo list) ===

    addCardMessage: (type: ChatMessageCard['type'], projectPath: string) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content: '',
        timestamp: Date.now(),
        card: { type, projectPath, status: 'pending' },
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

      debouncedSave()
    },

    updateCardStatus: (messageId: string, status: ChatMessageCard['status']) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId || !msg.card) return msg
          return { ...msg, card: { ...msg.card, status } }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return { sessions: updatedSessions }
      })

      debouncedSave()
    },
  }
})
