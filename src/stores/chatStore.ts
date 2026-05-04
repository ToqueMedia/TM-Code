import { create } from 'zustand'
import { Attachment, ChatMessage, ChatMessageCard, ChatSession, CodeBlock, ContentBlock, ContentPart, ConversationMessage, PromptBlock, SessionSummary, SystemMessageLevel, ToolCallDisplay, type AnthropicContentBlock } from '../types/chat'
import DiffService, { DiffResult } from '../services/agent/diffService'
import { sessionService } from '../services/agent/sessionService'
import CheckpointService from '../services/agent/checkpointService'
import { useCheckpointStore } from './checkpointStore'
import { usePermissionStore } from './permissionStore'
import { useToastStore } from './toastStore'
import { clearCommandQueue as clearMessageQueue } from '../services/agent/messageQueue'
export { clearMessageQueue }
import { setQueueLogContext } from '../services/agent/queueOperationLog'
import { logger } from '../utils/logger'
import { t } from '../i18n'

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
  /** Timestamp (ms) when the current agent loop started. Used for elapsed time display. */
  agentStartTime: number | null
  pendingDiffs: DiffResult[]
  /** Draft prompt text — shared across PromptBar instances (chat + preview) */
  draftInput: string
  /** Draft attachments for the current message */
  draftAttachments: Attachment[]
}

interface ChatActions {
  createSession: (projectPath: string) => string
  getActiveSession: () => ChatSession | null
  setActiveSession: (sessionId: string) => void
  addUserMessage: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => string
  /**
   * Remove a message from the active session by id. Used to drop the
   * chat bubble associated with a cancelled queued command.
   */
  removeMessageById: (messageId: string) => void
  /**
   * Insert a user message BEFORE the streaming assistant message.
   * Used by mid-turn drain to keep visual order correct:
   *   user_msg → queued_user_msg → assistant_response
   *   (not: user_msg → assistant_response → queued_user_msg)
   */
  insertUserMessageBeforeAssistant: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => string
  addSystemMessage: (content: string, level?: SystemMessageLevel) => void
  startAssistantMessage: () => string
  finalizeAssistantMessage: () => void
  addCodeBlockToMessage: (messageId: string, block: CodeBlock) => void
  updateCodeBlockStatus: (messageId: string, blockId: string, status: 'applied' | 'rejected') => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  clearSession: (sessionId: string) => void
  /** Clear messages within a session but keep the session alive. Also resets tokens and turn count. */
  clearSessionMessages: (sessionId: string) => void
  // Streaming actions
  appendTextDelta: (delta: string) => void
  appendReasoningDelta: (delta: string) => void
  // Reasoning toggle
  toggleReasoning: (messageId: string) => void
  // Tool call actions (pending -> start -> result)
  addPendingToolCall: (toolId: string, toolName: string, spawnedBy?: string, targetMessageId?: string) => void
  updateToolCallWithArgs: (toolId: string, args: Record<string, unknown>, targetMessageId?: string) => void
  updateToolCallWithResult: (toolId: string, result: string, isError: boolean, targetMessageId?: string) => void
  updateToolCallProgress: (toolId: string, progressText: string) => void
  /** Record the permission decision that gated this tool call. Called by
   *  toolExecutor right after `requestPermission` resolves. Surfaces in the
   *  session export so forensics can tell user-approved tools apart from
   *  silent auto-approvals (the bug behind misattributing destructive
   *  commands to model improvisation). */
  recordToolPermission: (toolId: string, permission: NonNullable<ToolCallDisplay['permission']>, targetMessageId?: string) => void
  // Inline diff actions (centralized — handle DiffService + store + agent unblock atomically)
  approveDiff: (messageId: string, toolCallId: string, diffResultId: string | undefined) => Promise<void>
  rejectDiff: (messageId: string, toolCallId: string, diffResultId: string | undefined) => void
  approveAllPendingDiffs: () => Promise<void>
  rejectAllAndStop: () => Promise<void>
  // Low-level diff status (used internally / by GeneratingView)
  updateToolCallDiffStatus: (messageId: string, toolCallId: string, status: 'approved' | 'denied') => void
  syncDiffStatusByResultId: (diffResultId: string, status: 'approved' | 'denied') => void
  updateConversationHistory: (messages: ConversationMessage[]) => void
  incrementTurnCount: () => void
  addTokenUsage: (input: number, output: number) => void
  /** Reset the per-request token counter. Called at the start of each new
   *  agent request (runAgentInternal entry) so the indicator scopes to the
   *  current request, not the session-cumulative total. */
  resetTokenUsage: () => void
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
  renameSession: (name: string) => void
  deleteSessionFromDisk: (projectPath: string, sessionId: string) => Promise<void>
  initPersistence: (projectPath: string) => Promise<void>
  cleanupOnExit: (projectPath: string) => Promise<void>
  setDraftInput: (value: string) => void
  addDraftAttachment: (attachment: Attachment) => void
  removeDraftAttachment: (id: string) => void
  clearDraftAttachments: () => void
  clearAllSessions: () => void
  // Card messages (plan approval, todo list)
  addCardMessage: (type: ChatMessageCard['type'], projectPath: string) => void
  /** Add a credential_request card with field metadata. Returns the message id so the
   *  card can update its own status when the user submits or cancels. */
  addCredentialRequestCard: (
    projectPath: string,
    requestId: string,
    serviceName: string,
    fields: NonNullable<ChatMessageCard['fields']>,
  ) => string
  /** Mark a credential_request card as submitted and record which keys were saved (no values). */
  markCredentialRequestSubmitted: (messageId: string, submittedKeys: string[]) => void
  updateCardStatus: (messageId: string, status: ChatMessageCard['status']) => void
}

let idCounter = 0
export function generateId(prefix: string): string {
  idCounter++
  return `${prefix}-${Date.now()}-${idCounter}`
}

// === Project-scope epoch ===
//
// Sessions are project-scoped: a session belongs only to the project that
// created it. Rapid project switches (A → B → C) race the async session
// loaders — the loader for B can resolve AFTER the user is already on C, and
// without a guard it would write B's session into C's chat state.
//
// Strategy: every clearAllSessions() bumps the epoch. Async loaders capture
// the current epoch at entry, and skip their final `set()` if the epoch has
// moved on. Module-level (not in store state) so listeners aren't triggered
// by epoch bumps; the guard is purely a write-time check.
let projectEpoch = 0
function bumpProjectEpoch(): number {
  return ++projectEpoch
}
function currentProjectEpoch(): number {
  return projectEpoch
}

// === Persisted agent start time ===
// Survives app crash/reload so elapsed time isn't lost.
const AGENT_START_TIME_KEY = 'chat_agentStartTime'
function persistAgentStartTime(timestamp: number): void {
  try { localStorage.setItem(AGENT_START_TIME_KEY, String(timestamp)) } catch { /* storage unavailable */ }
}
function restoreAgentStartTime(): number | null {
  try {
    const raw = localStorage.getItem(AGENT_START_TIME_KEY)
    if (raw) {
      const ts = parseInt(raw, 10)
      // Sanity check: must be within last 24 hours (stale data)
      if (Date.now() - ts < 24 * 60 * 60 * 1000) return ts
    }
  } catch { /* ignore */ }
  return null
}
function clearAgentStartTime(): void {
  try { localStorage.removeItem(AGENT_START_TIME_KEY) } catch { /* ignore */ }
}
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

// Throttled save during streaming — persists partial content every 5s
// so interrupted/crashed sessions don't lose the assistant's work.
let streamingSaveInterval: ReturnType<typeof setInterval> | null = null
function startStreamingSave() {
  if (streamingSaveInterval) return // already running
  streamingSaveInterval = setInterval(() => {
    sessionService.markDirty()
    sessionService.flushNow().catch(err =>
      logger.error('chat', 'Streaming auto-save failed:', err)
    )
  }, 5000)
}
function stopStreamingSave() {
  if (streamingSaveInterval) {
    clearInterval(streamingSaveInterval)
    streamingSaveInterval = null
  }
}

// === Diff approval promises ===
// Module-level map: toolCallId → resolve callback
// Used to make the agent wait until the user approves/rejects a file change.
const pendingDiffApprovals = new Map<string, (approved: boolean) => void>()

// Timeout for diff approvals — 30 minutes. Prevents the agent from
// being blocked forever if the user walks away with pending diffs.
const DIFF_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000
const approvalTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Resolve a diff approval by its diffResultId (not toolCallId).
 * Used by GeneratingView which only has access to diffResultId.
 * Finds the associated toolCallId via the session or pendingDiffs store.
 */
export function resolveDiffApprovalByResultId(diffResultId: string, approved: boolean): void {
  // Find the toolCallId from pendingDiffs (authoritative source)
  const pendingDiffs = useChatStore.getState().pendingDiffs
  const diff = pendingDiffs.find(d => d.id === diffResultId)
  if (diff?.toolCallId) {
    resolveDiffApproval(diff.toolCallId, approved)
    return
  }
  // Fallback: search session messages
  const session = useChatStore.getState().getActiveSession()
  if (session) {
    for (const msg of session.messages) {
      const tc = msg.toolCalls?.find(t => t.diffResultId === diffResultId)
      if (tc?.id) {
        resolveDiffApproval(tc.id, approved)
        return
      }
    }
  }
  // Not found — the approval may have already been resolved (race between
  // GeneratingView and inline approval), or the diffResultId is stale.
}

export async function createDiffApprovalPromise(toolCallId: string): Promise<boolean> {
  // If auto-approve diffs is enabled (user clicked "Accept All" earlier),
  // accept the diff immediately without blocking the agent.
  if (usePermissionStore.getState().autoApproveDiffs) {
    // Primary path: search pendingDiffs for the diffResultId (race-safe —
    // pendingDiffs is populated before the approval promise is created).
    const pendingDiffs = useChatStore.getState().pendingDiffs
    const pending = pendingDiffs.find(d => d.toolCallId === toolCallId)
    if (pending) {
      try {
        await DiffService.getInstance().acceptDiff(pending.id)
      } catch (err) {
        logger.error('chat', 'Auto-approve acceptDiff failed:', String(err))
      }
      useChatStore.getState().syncDiffStatusByResultId(pending.id, 'approved')
      useChatStore.getState().removePendingDiff(pending.id)
      return true
    }

    // Fallback path: search session messages (timing edge case where
    // pendingDiffs hasn't been added yet — very rare, < 1 frame).
    const session = useChatStore.getState().getActiveSession()
    if (session) {
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const tc = session.messages[i].toolCalls?.find(t => t.id === toolCallId)
        if (tc?.diffResultId) {
          try {
            await DiffService.getInstance().acceptDiff(tc.diffResultId)
          } catch (err) {
            logger.error('chat', 'Auto-approve acceptDiff failed:', String(err))
          }
          useChatStore.getState().syncDiffStatusByResultId(tc.diffResultId, 'approved')
          useChatStore.getState().removePendingDiff(tc.diffResultId)
          return true
        }
      }
    }

    // Neither path found — the tool call may not have a diff yet (should
    // not happen, but be safe: still return true to avoid blocking the agent).
    logger.warn('chat', `Auto-approve: no diff found for toolCallId ${toolCallId}`)
    return true
  }

  return new Promise(resolve => {
    pendingDiffApprovals.set(toolCallId, resolve)
    // Set timeout — auto-reject after 30 minutes to prevent the agent
    // from being blocked forever if the user walks away.
    const timeout = setTimeout(() => {
      if (pendingDiffApprovals.has(toolCallId)) {
        logger.warn('chat', `Diff approval timed out after ${DIFF_APPROVAL_TIMEOUT_MS / 60000}min for toolCallId ${toolCallId}. Auto-rejecting.`)
        resolve(false)
        pendingDiffApprovals.delete(toolCallId)
      }
      approvalTimeouts.delete(toolCallId)
    }, DIFF_APPROVAL_TIMEOUT_MS)
    approvalTimeouts.set(toolCallId, timeout)
  })
}

export function resolveDiffApproval(toolCallId: string, approved: boolean) {
  const resolve = pendingDiffApprovals.get(toolCallId)
  if (resolve) {
    // Clear the timeout — no longer needed
    const timeout = approvalTimeouts.get(toolCallId)
    if (timeout) { clearTimeout(timeout); approvalTimeouts.delete(toolCallId) }
    resolve(approved)
    pendingDiffApprovals.delete(toolCallId)
  }
}

export function resolveAllPendingDiffApprovals(approved: boolean) {
  // Clear all timeouts
  for (const [, timeout] of approvalTimeouts) {
    clearTimeout(timeout)
  }
  approvalTimeouts.clear()

  for (const [, resolve] of pendingDiffApprovals) {
    resolve(approved)
  }
  pendingDiffApprovals.clear()
}

// Streaming delta buffer (50ms flush window).
//
// We use a SINGLE ordered queue, not two separate buffers. The previous
// implementation kept `textBuffer` and `reasoningBuffer` independent and
// flushed text-first-then-reasoning, which silently re-ordered events
// when both kinds arrived inside the same 50ms window. Symptom: a single
// reasoning thought got split into two ReasoningBlocks with a stray text
// fragment between them, because the flush emitted the text BEFORE the
// later reasoning chunk that was actually meant to extend the current block.
//
// Preserving arrival order keeps reasoning/text/reasoning interleaving honest
// — each ContentBlock boundary in the rendered message reflects a real
// upstream boundary, not an artefact of our flush schedule.
type DeltaEntry = { kind: 'text' | 'reasoning'; delta: string }
let deltaQueue: DeltaEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function appendTextDeltaBuffered(delta: string) {
  // Coalesce with the immediately preceding text entry so multiple character-
  // sized text_delta events don't churn the renderer with one append per byte.
  const last = deltaQueue[deltaQueue.length - 1]
  if (last && last.kind === 'text') {
    last.delta += delta
  } else {
    deltaQueue.push({ kind: 'text', delta })
  }
  scheduleFlush()
}

export function appendReasoningDeltaBuffered(delta: string) {
  // Same coalescing rule for reasoning — but ONLY when the previous queued
  // entry is also reasoning. Crossing kinds (reasoning → text → reasoning)
  // creates a separate entry so the temporal boundary is preserved when the
  // queue is replayed on the next flush.
  const last = deltaQueue[deltaQueue.length - 1]
  if (last && last.kind === 'reasoning') {
    last.delta += delta
  } else {
    deltaQueue.push({ kind: 'reasoning', delta })
  }
  scheduleFlush()
}

/**
 * Signal that a reasoning content_block just ended. With per-block reasoning
 * (each chunk is its own ContentBlock), the natural boundary is a tool call
 * or a text delta arriving — no separator string needed. We still expose this
 * function so any future caller can finalize the last reasoning block early
 * (e.g. `onReasoningComplete` from the parser).
 */
export function markReasoningBoundary(): void {
  // Flush any queued deltas first so the boundary closes the right block.
  flushBufferedDeltas()
  const state = useChatStore.getState()
  const { activeSessionId, streamingMessageId, sessions } = state
  if (!activeSessionId || !streamingMessageId) return
  const session = sessions.get(activeSessionId)
  if (!session) return
  const msg = session.messages.find(m => m.id === streamingMessageId)
  if (!msg?.contentBlocks) return
  const last = msg.contentBlocks[msg.contentBlocks.length - 1]
  if (last && last.type === 'reasoning' && last.durationMs === undefined && last.startedAt) {
    last.durationMs = Date.now() - last.startedAt
    // Bump streamingVersion so subscribers see the boundary immediately.
    useChatStore.setState(s => ({ streamingVersion: s.streamingVersion + 1 }))
  }
}

function scheduleFlush() {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const queued = deltaQueue
      deltaQueue = []
      flushTimer = null

      const store = useChatStore.getState()
      // Replay each entry in arrival order. Mixed text/reasoning sequences
      // therefore land in contentBlocks with the same interleaving the model
      // emitted them in.
      for (const entry of queued) {
        if (entry.kind === 'text') store.appendTextDelta(entry.delta)
        else store.appendReasoningDelta(entry.delta)
      }
    }, 50)
  }
}

/**
 * Returns the name of the most recently completed tool in the current
 * streaming message. Used by the status bar to surface "Processed {tool} —
 * awaiting response..." instead of the generic "Awaiting response..." while
 * the model decides what to do next.
 *
 * Walks toolCalls in reverse and picks the latest one whose status is
 * 'completed' or 'failed' — running tools belong to the 'applying' state,
 * not 'awaiting_response'. Returns null when nothing has completed yet.
 */
export function selectLastCompletedToolName(state: ChatState): string | null {
  const { activeSessionId, streamingMessageId, sessions } = state
  if (!activeSessionId || !streamingMessageId) return null
  const session = sessions.get(activeSessionId)
  if (!session) return null
  const msg = session.messages.find(m => m.id === streamingMessageId)
  if (!msg?.toolCalls?.length) return null
  for (let i = msg.toolCalls.length - 1; i >= 0; i--) {
    const tc = msg.toolCalls[i]
    if (tc.status === 'completed' || tc.status === 'failed') return tc.toolName
  }
  return null
}

export function flushBufferedDeltas() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const queued = deltaQueue
  deltaQueue = []

  const store = useChatStore.getState()
  for (const entry of queued) {
    if (entry.kind === 'text') store.appendTextDelta(entry.delta)
    else store.appendReasoningDelta(entry.delta)
  }
}

// Per-result truncation for very large tool outputs (e.g. read_file on huge files)
const MAX_TOOL_RESULT_CHARS = 4000

/** One-shot warning so we don't spam the log on every reload. */
let _warnedAboutMissingBase64 = false

/**
 * Build a `ContentPart[]` for a user message with image attachments.
 *
 * Two paths:
 *  1. **Block path (preferred)** — when `msg.promptBlocks` is present,
 *     walk it in order. This preserves the original interleaving the
 *     user typed (text → image → text → image), matching what the
 *     model saw on the first turn.
 *  2. **Fallback path** — derive content parts from `msg.content` +
 *     `msg.attachments` as text-first-then-images. Used when the
 *     message was created before the block path existed (older
 *     sessions, or paths that didn't pass promptBlocks).
 *
 * Returns `null` if the message has no image attachments OR none of
 * the image attachments have base64 cached (e.g. message was loaded
 * from disk where base64 is stripped). The caller falls back to plain
 * text content with the model still seeing the textual
 * `<attached_image>` placeholder via the existing path.
 */
function userMessageToContentParts(msg: ChatMessage): ContentPart[] | null {
  // === Block path ===
  if (msg.promptBlocks?.length) {
    const parts: ContentPart[] = []
    let hasImage = false
    let hasNonEmptyText = false
    for (const block of msg.promptBlocks) {
      if (block.type === 'text') {
        if (block.text.trim().length > 0) {
          parts.push({ type: 'text', text: block.text })
          hasNonEmptyText = true
        }
      } else {
        const att = block.attachment
        if (att.type === 'image' && att.base64) {
          parts.push({ type: 'image_url', image_url: { url: att.base64 } })
          hasImage = true
        }
      }
    }
    if (!hasImage) return null
    if (!hasNonEmptyText) {
      parts.unshift({ type: 'text', text: t('prompt.fallbackAnalyzeImages') })
    }
    return parts
  }

  // === Fallback path ===
  const imageAttachments = msg.attachments?.filter(a => a.type === 'image' && a.base64)
  if (!imageAttachments || imageAttachments.length === 0) {
    // Detect silent degradation: message has image attachments but
    // none have base64 cached (likely loaded from disk where base64
    // is stripped). Warn once per session so developers know follow-up
    // turns are degraded to text-only for these messages.
    const hasImagesWithoutBase64 = msg.attachments?.some(
      a => a.type === 'image' && !a.base64,
    )
    if (hasImagesWithoutBase64 && !_warnedAboutMissingBase64) {
      _warnedAboutMissingBase64 = true
      logger.warn(
        'chat',
        'A user message has image attachments without cached base64 — ' +
        'multimodal context for this message has degraded to text. This ' +
        'usually happens after reloading a session from disk (base64 is ' +
        'stripped at persistence time to keep session files small).',
      )
    }
    return null
  }

  const parts: ContentPart[] = []
  const text = msg.content.trim()
  if (text.length > 0) {
    parts.push({ type: 'text', text: msg.content })
  } else {
    parts.push({ type: 'text', text: t('prompt.fallbackAnalyzeImages') })
  }
  for (const img of imageAttachments) {
    parts.push({
      type: 'image_url',
      image_url: { url: img.base64! },
    })
  }
  return parts
}

/**
 * Rebuild conversation history in Anthropic Messages API format.
 *
 * Anthropic format differences from OpenAI:
 *   - No role:'system' (system prompt is top-level in the request body)
 *   - No role:'tool' — tool results are content blocks inside role:'user' messages
 *   - Assistant tool_calls → tool_use content blocks inside role:'assistant' content array
 *   - Thinking/reasoning → thinking content blocks
 *   - Strictly alternating user/assistant messages (no consecutive same-role)
 */
function rebuildConversationHistory(messages: ChatMessage[]): ConversationMessage[] {
  const history: ConversationMessage[] = []

  for (const msg of messages) {
    // System messages are UI-only status lines — never send to the LLM
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      const parts = userMessageToContentParts(msg)
      history.push({
        role: 'user',
        content: parts ?? msg.content,
      })
    } else if (msg.role === 'assistant') {
      // Build Anthropic content blocks array
      const blocks: AnthropicContentBlock[] = []

      // Thinking/reasoning → thinking block
      if (msg.reasoningContent) {
        blocks.push({ type: 'thinking', thinking: msg.reasoningContent })
      }

      // Text → text block
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content })
      }

      // Tool calls → tool_use blocks
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.toolName,
            input: tc.input || {},
          })
        }
      }

      history.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : msg.content || '',
      })

      // Tool results → single user message with tool_result content blocks
      // (Anthropic requires tool_results in a role:'user' message, not role:'tool')
      if (msg.toolCalls?.length) {
        const toolResultBlocks: AnthropicContentBlock[] = []

        for (const tc of msg.toolCalls) {
          // Orphan tool call: agent was cancelled mid-execution
          if (tc.status === 'running' || tc.result === undefined) {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: 'Tool call was interrupted.',
            })
            continue
          }

          let resultContent = tc.result || ''

          // Sanitize diff JSON
          try {
            const parsed = JSON.parse(resultContent)
            if (parsed.type === 'diff') {
              resultContent = `File ${parsed.isNewFile ? 'created' : 'updated'}: ${parsed.path}`
            }
          } catch { /* not JSON */ }

          // Truncate large results
          if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
            resultContent = resultContent.slice(0, MAX_TOOL_RESULT_CHARS) + '\n[... truncated]'
          }

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: resultContent,
          })
        }

        if (toolResultBlocks.length > 0) {
          history.push({
            role: 'user',
            content: toolResultBlocks,
          })
        }
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
    agentStartTime: restoreAgentStartTime(),
    pendingDiffs: [],
    draftInput: '',
    draftAttachments: [],

    setDraftInput: (value: string) => set({ draftInput: value }),

    addDraftAttachment: (attachment: Attachment) => set(state => {
      if (state.draftAttachments.length >= 10) return state
      // Deduplicate by path (skip for pasted images which have no path)
      if (attachment.path && state.draftAttachments.some(a => a.path === attachment.path)) return state
      return { draftAttachments: [...state.draftAttachments, attachment] }
    }),

    removeDraftAttachment: (id: string) => set(state => ({
      draftAttachments: state.draftAttachments.filter(a => a.id !== id)
    })),

    clearDraftAttachments: () => set({ draftAttachments: [] }),

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

      // Scope the queue operation log to this project + session.
      setQueueLogContext(projectPath, sessionId)

      return sessionId
    },

    getActiveSession: () => {
      const { sessions, activeSessionId } = get()
      if (!activeSessionId) return null
      return sessions.get(activeSessionId) || null
    },

    setActiveSession: (sessionId: string) => {
      set({ activeSessionId: sessionId })
      // Re-scope the queue log to the newly-active session.
      const session = get().sessions.get(sessionId)
      if (session) setQueueLogContext(session.projectPath, sessionId)
    },

    addUserMessage: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'user',
        content,
        timestamp: Date.now(),
        // Keep base64 in the in-memory ChatMessage so follow-up turns
        // (rebuildConversationHistory) can reconstruct content parts
        // for vision-capable models. Disk persistence strips base64
        // separately in sessionService.sanitizeMessageForSave.
        attachments: attachments?.length ? attachments : undefined,
        // Optional prompt block representation — present when the
        // caller has the original interleaved order. Used by
        // userMessageToContentParts to preserve text↔image ordering
        // across batched messages.
        promptBlocks: promptBlocks?.length ? promptBlocks : undefined,
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

    removeMessageById: (messageId: string) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state
        const session = sessions.get(activeSessionId)
        if (!session) return state
        const filtered = session.messages.filter(m => m.id !== messageId)
        if (filtered.length === session.messages.length) return state
        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, {
          ...session,
          messages: filtered,
          updatedAt: Date.now(),
        })
        return { sessions: updatedSessions }
      })
      debouncedSave()
    },

    insertUserMessageBeforeAssistant: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments: attachments?.length ? attachments : undefined,
        promptBlocks: promptBlocks?.length ? promptBlocks : undefined,
      }

      set(state => {
        const { activeSessionId, streamingMessageId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        // Find the index of the streaming assistant message
        const assistantIdx = streamingMessageId
          ? session.messages.findIndex(m => m.id === streamingMessageId)
          : -1

        // Insert before the assistant message, or append if not found
        const insertIdx = assistantIdx >= 0 ? assistantIdx : session.messages.length
        const newMessages = [...session.messages]
        newMessages.splice(insertIdx, 0, message)

        const updatedSession: ChatSession = {
          ...session,
          messages: newMessages,
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

    addSystemMessage: (content: string, level?: SystemMessageLevel) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content,
        timestamp: Date.now(),
        ...(level && { level }),
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
          agentStartTime: Date.now(),
        }
      })

      // Persist to survive app crash/reload
      persistAgentStartTime(Date.now())

      startStreamingSave()
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
        // Maintain interleaved contentBlocks: append to last text block or create new one.
        // If the last block is an in-flight reasoning block, finalize it first so the
        // ReasoningBlock UI stops streaming and the text appears below it.
        const blocks = msg.contentBlocks || (msg.contentBlocks = [])
        const last = blocks[blocks.length - 1]
        if (last && last.type === 'reasoning' && last.durationMs === undefined && last.startedAt) {
          last.durationMs = Date.now() - last.startedAt
        }
        const refreshedLast = blocks[blocks.length - 1]
        if (refreshedLast && refreshedLast.type === 'text') {
          refreshedLast.text += delta
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
        // Track when reasoning started (legacy field — kept for the
        // session export and the message-level streaming-label fallback).
        if (!msg.reasoningStartedAt) {
          msg.reasoningStartedAt = Date.now()
        }
        // Keep msg.reasoningContent updated as a flat concatenation. Used by
        // session export, conversation history rebuild, and any legacy
        // renderer that reads the message-level field directly.
        msg.reasoningContent = (msg.reasoningContent || '') + delta

        // Mirror into contentBlocks so reasoning interleaves naturally with
        // tool calls and text. Each reasoning chunk between boundaries is its
        // own block — when a tool or text arrives, the active reasoning block
        // is finalized (durationMs set) so the next reasoning delta starts a
        // fresh block.
        const blocks = msg.contentBlocks || (msg.contentBlocks = [])
        const last = blocks[blocks.length - 1]
        if (last && last.type === 'reasoning' && last.durationMs === undefined) {
          last.text += delta
        } else {
          blocks.push({
            type: 'reasoning',
            text: delta,
            startedAt: Date.now(),
          })
        }

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

    addPendingToolCall: (toolId: string, toolName: string, spawnedBy?: string, targetMessageId?: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId) return
      // When `targetMessageId` is provided, write to that specific message —
      // used by background sub-agents that keep running after the main turn
      // finalizes (streamingMessageId becomes null but the message still exists
      // in the session and must keep receiving events for full user visibility).
      const targetId = targetMessageId ?? streamingMessageId
      if (!targetId) return

      const session = sessions.get(activeSessionId)
      if (!session) return
      // Guard against writes to a message that no longer exists (e.g. session was cleared).
      if (!session.messages.some(m => m.id === targetId)) return

      const toolCall: ToolCallDisplay = {
        id: toolId,
        toolName,
        input: {},
        status: 'running',
        timestamp: Date.now(),
        ...(spawnedBy ? { spawnedBy } : {}),
      }

      const messages = session.messages.map(msg => {
        if (msg.id !== targetId) return msg
        // Finalize reasoning timing if tool call arrives before text
        const reasoningDurationMs = (msg.reasoningStartedAt && !msg.reasoningDurationMs)
          ? Date.now() - msg.reasoningStartedAt
          : msg.reasoningDurationMs
        // Clone blocks so we can finalize the last reasoning block (if any)
        // before appending the tool_call. The block-level durationMs is what
        // each ReasoningBlock UI reads to flip from streaming to collapsed.
        const contentBlocks = (msg.contentBlocks || []).map(b => ({ ...b }))
        const last = contentBlocks[contentBlocks.length - 1]
        if (last && last.type === 'reasoning' && last.durationMs === undefined && last.startedAt) {
          last.durationMs = Date.now() - last.startedAt
        }
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

    updateToolCallWithArgs: (toolId: string, args: Record<string, unknown>, targetMessageId?: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId) return
      const targetId = targetMessageId ?? streamingMessageId
      if (!targetId) return

      const session = sessions.get(activeSessionId)
      if (!session) return
      if (!session.messages.some(m => m.id === targetId)) return

      const messages = session.messages.map(msg => {
        if (msg.id !== targetId) return msg
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
      if (!msg || !msg.toolCalls) return

      const idx = msg.toolCalls.findIndex(t => t.id === toolId)
      if (idx < 0) return

      // Replace the tool call with a new reference so memoized consumers
      // (TerminalToolCall uses default memo) detect the change. The parent
      // message keeps the same ref — streamingVersion drives parent rerender.
      const newToolCalls = msg.toolCalls.slice()
      newToolCalls[idx] = { ...newToolCalls[idx], progressText }
      msg.toolCalls = newToolCalls
      session.updatedAt = Date.now()

      set(s => ({ streamingVersion: s.streamingVersion + 1 }))
    },

    recordToolPermission: (toolId, permission, targetMessageId) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId) return
      const targetId = targetMessageId ?? streamingMessageId
      if (!targetId) return
      const session = sessions.get(activeSessionId)
      if (!session) return
      const msg = session.messages.find(m => m.id === targetId)
      if (!msg || !msg.toolCalls) return
      const idx = msg.toolCalls.findIndex(t => t.id === toolId)
      if (idx < 0) return
      const newToolCalls = msg.toolCalls.slice()
      newToolCalls[idx] = { ...newToolCalls[idx], permission }
      msg.toolCalls = newToolCalls
      session.updatedAt = Date.now()
      set(s => ({ streamingVersion: s.streamingVersion + 1 }))
    },

    updateToolCallWithResult: (toolId: string, result: string, isError: boolean, targetMessageId?: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId) return
      const targetId = targetMessageId ?? streamingMessageId
      if (!targetId) return

      const session = sessions.get(activeSessionId)
      if (!session) return
      if (!session.messages.some(m => m.id === targetId)) return

      let newDiff: DiffResult | null = null

      const messages = session.messages.map(msg => {
        if (msg.id !== targetId) return msg
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
                // CMD mode writes directly to disk and marks the diff as
                // alreadyApplied — skip the approval queue entirely. Chat
                // mode always starts pending and waits for user approval.
                // The "accepted" badge must only appear after a real write
                // happens on disk (chat mode: DiffService.acceptDiff; cmd
                // mode: the tool itself) — otherwise an aborted/failed write
                // would leave the UI claiming the file was saved when it
                // wasn't.
                if (parsed.alreadyApplied === true) {
                  diffStatus = 'approved'
                } else {
                  diffStatus = 'pending'

                  // Create DiffResult for DiffService + GeneratingView.
                  // Skipped in cmd mode — there's no approval flow to drive.
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
        set(s => ({
          sessions: updatedSessions,
          pendingDiffs: [...s.pendingDiffs, newDiff!],
          streamingVersion: s.streamingVersion + 1,
        }))
      } else {
        set(s => ({
          sessions: updatedSessions,
          streamingVersion: s.streamingVersion + 1,
        }))
      }
    },

    // === Centralized diff approve/reject ===
    // These handle the ENTIRE flow atomically: DiffService → store update → agent unblock

    approveDiff: async (messageId: string, toolCallId: string, diffResultId: string | undefined) => {
      // 1. Write file via DiffService. We MUST observe write failures here
      //    instead of swallowing them — the agent acts on whatever signal we
      //    return, and an unflagged failure leaves it convinced a file exists
      //    when it doesn't (observed bug: write_file for a path whose parent
      //    dir was missing reported "approved" while the file was never
      //    created, breaking later reads + tools).
      let writeError: string | null = null
      if (diffResultId) {
        try {
          await DiffService.getInstance().acceptDiff(diffResultId)
        } catch (err) {
          writeError = err instanceof Error ? err.message : String(err)
          logger.error('chat', 'DiffService.acceptDiff failed:', writeError)
        }
      }

      // 2. Atomic state update — diffStatus reflects the real outcome.
      //    On failure we mark the diff as 'denied' (write didn't land) and
      //    surface the error to the user via toast so they know why.
      const succeeded = writeError === null
      set(state => {
        const { activeSessionId, sessions, pendingDiffs } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          const toolCalls = (msg.toolCalls || []).map(tc =>
            tc.id === toolCallId
              ? {
                  ...tc,
                  diffStatus: (succeeded ? 'approved' : 'denied') as 'approved' | 'denied',
                  ...(succeeded ? {} : { isError: true, result: `Write failed: ${writeError}` }),
                }
              : tc
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

      if (!succeeded) {
        useToastStore.getState().addToast('error', `File write failed: ${writeError}`)
      }

      // 3. Unblock agent — pass the real outcome so it can react (retry,
      //    bail, ask the user) instead of charging ahead on a phantom file.
      resolveDiffApproval(toolCallId, succeeded)
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

    rejectAllAndStop: async () => {
      const { activeSessionId, sessions, pendingDiffs } = get()
      if (!activeSessionId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      // 1. Cancel the agent loop FIRST (lazy imports to avoid circular dependency)
      const [agentMod, agentStoreMod] = await Promise.all([
        import('../services/agent/agentService'),
        import('./agentStore'),
      ])
      agentMod.default.getInstance().cancelLoop()
      agentStoreMod.useAgentStore.getState().setStatus('idle')

      // 2. Reject all pending diffs in DiffService
      const diffService = DiffService.getInstance()
      for (const diff of pendingDiffs) {
        diffService.rejectDiff(diff.id)
      }

      // 3. Mark all pending tool call diffs as denied in the store
      const messages = session.messages.map(msg => {
        if (!msg.toolCalls) return msg
        const toolCalls = msg.toolCalls.map(tc =>
          tc.diffStatus === 'pending' ? { ...tc, diffStatus: 'denied' as const } : tc
        )
        return { ...msg, toolCalls }
      })

      const updatedSessions = new Map(sessions)
      updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })
      set({ sessions: updatedSessions, pendingDiffs: [] })

      // 4. Reject all pending diff approval promises
      resolveAllPendingDiffApprovals(false)

      // 5. Clear pending permission + finalize
      usePermissionStore.getState().clearPending()
      get().finalizeAssistantMessage()
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
          agentStartTime: null,
        }
      })

      // Clear persisted start time
      clearAgentStartTime()

      // Rebuild conversation history outside set() — avoids blocking
      // render with JSON parsing and string processing on large sessions.
      if (finalMessages) {
        const conversationHistory = rebuildConversationHistory(finalMessages)
        set({ conversationHistory })
      }

      stopStreamingSave()
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

    clearSessionMessages: (sessionId: string) => {
      // Clear module-level debounce timer
      if (saveTimeout) {
        clearTimeout(saveTimeout)
        saveTimeout = null
      }
      set(state => {
        const sessions = new Map(state.sessions)
        const session = sessions.get(sessionId)
        if (session) {
          sessions.set(sessionId, {
            ...session,
            messages: [],
            updatedAt: Date.now(),
          })
        }

        return {
          sessions,
          conversationHistory: [],
          currentTurnCount: 0,
          totalTokensUsed: { input: 0, output: 0 },
        }
      })
      // Mark dirty so the cleared state is persisted
      sessionService.markDirty()
    },

    updateConversationHistory: (messages: ConversationMessage[]) => {
      set({ conversationHistory: messages })
    },

    incrementTurnCount: () => {
      set(state => ({ currentTurnCount: state.currentTurnCount + 1 }))
    },

    addTokenUsage: (input: number, output: number) => {
      // Input is REPLACED, not summed — each turn's prompt re-sends the full
      // conversation, so summing per-turn inputs double-counts massively
      // (turn 50's prompt already contains turns 1-49). The latest turn's
      // input represents the current context size, which is the meaningful
      // metric. Output is summed because each turn emits NEW tokens.
      set(state => ({
        totalTokensUsed: {
          input: Math.max(state.totalTokensUsed.input, input),
          output: state.totalTokensUsed.output + output,
        }
      }))
    },

    resetTokenUsage: () => {
      set({ totalTokensUsed: { input: 0, output: 0 } })
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

      // 1c. Enable auto-approve for core tools and diffs in this session
      const permStore = usePermissionStore.getState()
      permStore.setAutoApproveDiffs(true)
      const scopes = new Set(permStore.approvedScopes)
      scopes.add('core')
      usePermissionStore.setState({ approvedScopes: scopes })

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
            // Message has tool calls but no contentBlocks — reconstruct.
            // Legacy messages have a flat `msg.reasoningContent` string instead
            // of per-block reasoning entries, so we prepend it as a single
            // reasoning block (preserves the visible position above the tools).
            const blocks: ContentBlock[] = []
            if (msg.reasoningContent) {
              blocks.push({
                type: 'reasoning',
                text: msg.reasoningContent,
                durationMs: msg.reasoningDurationMs,
              })
            }
            if (msg.content) {
              blocks.push({ type: 'text', text: msg.content })
            }
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
      // Capture the project epoch at entry. If it changes during the async
      // load (user switched projects again before this resolved), abort the
      // write so we don't poison the new project's chat state.
      const epoch = currentProjectEpoch()
      const isStale = () => currentProjectEpoch() !== epoch

      set({ isLoadingSession: true })
      try {
        await sessionService.init(projectPath)
        if (isStale()) return false
        const activeId = await sessionService.getActiveSessionId(projectPath)
        if (!activeId || isStale()) return false

        const session = await sessionService.loadSession(projectPath, activeId)
        if (isStale()) return false
        if (!session) {
          // Session file missing (e.g. app crashed before save) — clear the stale
          // active-session pointer so the same PathNotFound is not repeated on restart.
          await sessionService.setActiveSessionId(projectPath, '')
          return false
        }
        if (session.messages.length === 0) return false

        // Strip ephemeral system messages but keep card messages
        session.messages = session.messages.filter(m => m.role !== 'system' || m.card)
        if (session.messages.length === 0) return false

        const conversationHistory = rebuildConversationHistory(session.messages)

        // Initialize checkpoint service for this restored session
        await CheckpointService.getInstance().initSession(projectPath, session.id)
        if (isStale()) return false
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
      // Capture epoch — abort the final `set()` if the user has since switched
      // away from this project. Same race-guard pattern as restoreLastSession.
      const epoch = currentProjectEpoch()
      const isStale = () => currentProjectEpoch() !== epoch

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

      // Clear message queue — queued messages belong to the previous session
      clearMessageQueue()

      // Reset tool permission auto-approve for the new session
      usePermissionStore.getState().resetAutoApprove()

      // Ensure persistence is initialized (covers case where restoreLastSession returned false)
      await sessionService.init(projectPath)
      if (isStale()) return ''
      const session = await sessionService.createSession(projectPath)
      if (isStale()) return ''

      // Initialize checkpoint service for this session
      await CheckpointService.getInstance().initSession(projectPath, session.id)
      if (isStale()) return ''
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

      // Scope the queue operation log to the new project + session.
      setQueueLogContext(projectPath, session.id)

      sessionService.startAutoSave(30000)
      return session.id
    },

    switchSession: async (projectPath: string, sessionId: string) => {
      set({ isLoadingSession: true })
      try {
        // Finalize any streaming message before saving — avoids partial/corrupt saves
        get().finalizeAssistantMessage()

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

        // Clear message queue — queued messages belong to the previous session
        clearMessageQueue()

        // Reset tool permission auto-approve for the new session
        usePermissionStore.getState().resetAutoApprove()

        // loadSessionFromDisk already initializes checkpoints for the session
        const beforeSessionId = get().activeSessionId
        await get().loadSessionFromDisk(projectPath, sessionId)

        // Verify the session was actually loaded — loadSessionFromDisk silently
        // returns if the file doesn't exist, leaving the old session active.
        if (get().activeSessionId === beforeSessionId && beforeSessionId !== sessionId) {
          throw new Error(`Session "${sessionId}" not found on disk.`)
        }
      } finally {
        set({ isLoadingSession: false })
      }
    },

    renameSession: (name: string) => {
      const session = get().getActiveSession()
      if (!session) return
      session.name = name
      // Name is persisted on next saveSessionToDisk() call via updateIndex
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
      // Bumping the epoch invalidates any in-flight async session loader so
      // its `set()` is skipped — prevents the previous project's data from
      // landing in the new project's chat state on rapid A → B → C switches.
      bumpProjectEpoch()
      // Clear message queue — queued messages belong to the previous project
      clearMessageQueue()
      // Clear module-level timers to prevent stale writes
      if (saveTimeout) {
        clearTimeout(saveTimeout)
        saveTimeout = null
      }
      stopStreamingSave()
      // Drop the invoked-skills cache (post-compaction recovery state). This
      // map is module-level so it would otherwise leak across project switches
      // and re-inject a previous project's skills into a new project's chat.
      import('../services/agent/skillService').then(m => m.clearInvokedSkills()).catch(() => {})
      set({
        sessions: new Map(),
        activeSessionId: null,
        conversationHistory: [],
        isStreaming: false,
        streamingMessageId: null,
        agentStartTime: null,
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

    addCredentialRequestCard: (projectPath, requestId, serviceName, fields) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content: '',
        timestamp: Date.now(),
        card: {
          type: 'credential_request',
          projectPath,
          status: 'pending',
          requestId,
          serviceName,
          fields,
        },
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
      return messageId
    },

    markCredentialRequestSubmitted: (messageId, submittedKeys) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId || !msg.card) return msg
          return {
            ...msg,
            card: { ...msg.card, status: 'submitted' as const, submittedKeys },
          }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return { sessions: updatedSessions }
      })

      debouncedSave()
    },
  }
})
