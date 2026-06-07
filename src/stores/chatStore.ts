import { create } from 'zustand'
import { Attachment, ChatMessage, ChatMessageCard, ChatSession, CodeBlock, CompactMetadata, ContentBlock, ContentBlockAPI, ContentPart, ConversationMessage, PlanResumePending, PromptBlock, SessionSummary, SystemMessageLevel, ToolCallDisplay } from '../types/chat'
import DiffService, { DiffResult } from '../services/agent/diffService'
import { sessionService, captureByokSnapshot } from '../services/agent/sessionService'
import CheckpointService from '../services/agent/checkpointService'
import { useCheckpointStore } from './checkpointStore'
import { useAgentStore } from './agentStore'
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
  /** Incremented when a compact boundary is inserted — forces React key changes in message list */
  conversationVersion: number
  /** True after a compact boundary when the post-compact survey should be shown (20% sampling) */
  postCompactSurveyPending: boolean
  error: string | null
  conversationHistory: ConversationMessage[]
  currentTurnCount: number
  /**
   * Token counters for the current user message (reset on addUserMessage,
   * persisted as accumulators across the agent's tool-loop turns within the
   * same message).
   *
   *   `input`  — MAX across turns (not SUM). Each turn's prompt re-sends
   *              the full conversation history, so summing would double-count
   *              (N turns × history-size = inflated total — the "↑ 904k"
   *              bug). MAX gives the peak wire-size, bounded by the context
   *              window and robust to mid-request compaction shrinking the
   *              prompt. The activity indicator ("↑ Nk") shows this.
   *
   *   `output` — SUMMED across turns. Each turn emits net-new tokens; the
   *              cumulative count is the total generation cost.
   *
   * NOT the right field for the context-window-pressure pill — that uses
   * `currentPromptTokens + currentResponseTokens` below (true context
   * occupancy: input tokens hold all past history, output tokens are the
   * current turn's generation not yet rolled into the next prompt).
   */
  totalTokensUsed: { input: number; output: number }
  /**
   * Last turn's prompt size, replaced (not summed) on every addTokenUsage.
   * Represents the amount of context actually sent over the wire on the most
   * recent API call — the natural denominator for the context-window pill's
   * "X% full" calculation. Reset to 0 on new user message and on compaction
   * boundary so the pill reflects the fresh post-compression state.
   */
  currentPromptTokens: number
  /**
   * Last turn's response (output) tokens — replaced per call, mirror of
   * `currentPromptTokens`. The context window holds BOTH input AND output.
   * `prompt_tokens` already includes all past history (previous outputs),
   * but the CURRENT turn's output tokens aren't yet in prompt_tokens —
   * they roll into the next turn's prompt. The pill therefore computes
   * pressure as `(inputTokens + outputTokens) / effectiveWindow` so long
   * reasoning/answer generations are reflected in real-time. Reset alongside
   * `currentPromptTokens`.
   */
  currentResponseTokens: number
  /** Timestamp (ms) when the current agent loop started. Used for elapsed time display. */
  agentStartTime: number | null
  pendingDiffs: DiffResult[]
  /** Draft prompt text — shared across PromptBar instances (chat + preview) */
  draftInput: string
  /** Draft attachments for the current message */
  draftAttachments: Attachment[]
  /**
   * Project path when the agent is awaiting plan-revision feedback (user
   * clicked "Request changes" on the PlanApprovalCard). Until cleared, the
   * NEXT user message routes to `executePlanRevision(prompt, projectPath)`
   * instead of the normal chat path — re-enters architect mode with the
   * existing PLAN.md as context, edits it, and emits a fresh approval card.
   * `null` = not in revision mode.
   *
   * Without this flag, the user's revision feedback ("add OAuth") gets
   * treated as a normal coding prompt, the default IDE system prompt
   * loads, and the agent starts IMPLEMENTING the original PLAN.md plus
   * the new request — the exact bug reported 2026-05-18.
   */
  planRevisionPending: { projectPath: string; planPath?: string } | string | null
  planResumePending: PlanResumePending | null
}

interface ChatActions {
  createSession: (projectPath: string) => string
  getActiveSession: () => ChatSession | null
  setActiveSession: (sessionId: string) => void
  addUserMessage: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => string
  /**
   * Insert a user message BEFORE the streaming assistant message.
   * Used by mid-turn drain to keep visual order correct:
   *   user_msg → queued_user_msg → assistant_response
   *   (not: user_msg → assistant_response → queued_user_msg)
   */
  insertUserMessageBeforeAssistant: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => string
  /**
   * Atomically split the streaming assistant message for a dispatched queue
   * message: finalises the current assistant bubble, appends the user message
   * AT THE END (where the user is reading), and starts a fresh streaming
   * assistant — subsequent text deltas/tool calls go into the new bubble.
   *
   * Why this exists separately from insertUserMessageBeforeAssistant: when a
   * queued message dispatches mid-stream, the previous strategy was to insert
   * the user bubble ABOVE the streaming assistant. Visually correct in array
   * order, but the user's viewport is locked to the bottom by stick-to-bottom
   * scrolling — the new bubble materialises hundreds of lines up and the user
   * never sees it. They report "the message disappeared". By splitting and
   * appending, the queued exchange (user → new assistant) lands at the
   * scroll position the user is actually watching.
   *
   * Returns the new streaming assistant message id so the caller can verify
   * the split landed.
   */
  splitForQueuedMessage: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => string
  addSystemMessage: (content: string, level?: SystemMessageLevel, options?: { ephemeral?: boolean; timeoutMs?: number }) => void
  addTerminalCommandResult: (command: string, output: string, exitCode: number) => void
  /**
   * Records a context-compression boundary. The marker renders as a
   * claude-vaz-style horizontal rule; ChatView hides every message above the
   * latest boundary so the visible transcript fits in the model's
   * post-compression view. Also resets `totalTokensUsed.input` so the
   * ContextWindowIndicator no longer pins to the pre-compression peak that
   * `addTokenUsage` had cached via `Math.max`.
   */
  addCompactBoundaryMessage: (beforeTokens: number, trigger?: import('@/types/chat').CompactMetadata['trigger'], messagesSummarized?: number) => void
  /**
   * Re-capture the current BYOK selection (provider/model/baseURL/caps)
   * from byokStore and store it as the active session's byokSnapshot.
   * Called from byokStore whenever the user changes their BYOK selection
   * so the indicator + agent routing stay in sync with the live choice.
   * No-op if no active session, or if the snapshot is unchanged.
   */
  syncByokSnapshot: () => void
  /**
   * Create an empty assistant message in the active session and return its
   * id. `thinkingRequested` should reflect whether the upcoming turn was
   * invoked with reasoning on (forced by /plan, /debug, /review, /te2e, or
   * the user toggle on a non-BYOK path). MessageBubble gates reasoning
   * block rendering on this flag — when the model emits reasoning anyway
   * (some BYOK reasoning models always do), the UI suppresses it.
   * Undefined preserves legacy behaviour (always render reasoning if
   * present), so older sessions don't change.
   */
  startAssistantMessage: (thinkingRequested?: boolean) => string
  finalizeAssistantMessage: () => void
  addCodeBlockToMessage: (messageId: string, block: CodeBlock) => void
  updateCodeBlockStatus: (messageId: string, blockId: string, status: 'applied' | 'rejected') => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  clearSession: (sessionId: string) => void
  /** Clear messages within a session but keep the session alive. Also resets tokens and turn count. */
  clearSessionMessages: (sessionId: string) => void
  /** Replace all messages in the active session (used by /compact). */
  replaceMessages: (messages: ChatMessage[]) => void
  /** Replace conversation history after manual compaction — updates session messages + rebuilds history. */
  replaceConversationHistory: (newHistory: ConversationMessage[]) => void
  /** Reset token counters to zero (used after compaction). */
  resetTokenCounters: () => void
  // Streaming actions
  appendTextDelta: (delta: string) => void
  appendReasoningDelta: (delta: string) => void
  // Reasoning toggle (message-level — legacy / fallback for messages
  // without per-block visibility metadata)
  toggleReasoning: (messageId: string) => void
  // Reasoning toggle for ONE specific reasoning block within a message.
  // The bug this fixes: prior to per-block state, `toggleReasoning` flipped
  // a single message-level flag and every reasoning block in that message
  // shared it — expanding one expanded all. blockIdx is the position of the
  // reasoning block inside `message.contentBlocks`.
  toggleReasoningBlock: (messageId: string, blockIdx: number) => void
  // Tool call actions (pending -> start -> result)
  addPendingToolCall: (toolId: string, toolName: string, spawnedBy?: string, targetMessageId?: string) => void
  updateToolCallWithArgs: (toolId: string, args: Record<string, unknown>, targetMessageId?: string) => void
  updateToolCallWithResult: (toolId: string, result: string, isError: boolean, targetMessageId?: string) => void
  updateToolCallProgress: (toolId: string, progressText: string) => void
  /** Append a line to the streaming command log for a tool call.
   *  Used by build/test/script commands that stream output via run_streaming_command.
   *  Each call appends one chunk to the `commandLogs` array on the tool call. */
  appendToolCallCommandLog: (toolId: string, logChunk: string) => void
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
  /** Flip the plan-revision flag — null clears it. */
  setPlanRevisionPending: (value: { projectPath: string; planPath?: string } | string | null) => void
  /** Track an interrupted /plan run that should resume in architect mode. */
  setPlanResumePending: (value: PlanResumePending | null) => void
  addDraftAttachment: (attachment: Attachment) => void
  removeDraftAttachment: (id: string) => void
  clearDraftAttachments: () => void
  setPostCompactSurveyPending: (value: boolean) => void
  setSessionMemory: (memory: string) => void
  clearAllSessions: () => void
  // Card messages (plan approval, todo list)
  addCardMessage: (
    type: ChatMessageCard['type'],
    projectPath: string,
    metadata?: Pick<ChatMessageCard, 'planPath' | 'planFileName'>,
  ) => void
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
  /** Add an ask_user_question card. Returns the message id. */
  addAskUserQuestionCard: (
    projectPath: string,
    requestId: string,
    questions: import('../stores/askUserQuestionStore').Question[],
  ) => string
  /** Remove a message from the active session by id. Used by credential cards
   *  to delete themselves from the transcript after the user accepts or cancels —
   *  the card is a transient UI element, not a permanent log entry, and stacking
   *  several at the end of the chat displaces the actual conversation flow. */
  removeMessage: (messageId: string) => void
  /** Append a sub-agent run ID to a message's subAgentRunIds array.
   *  Called by the task tool after spawning a sub-agent so the UI can
   *  render SubAgentCard for that run. */
  appendSubAgentRunId: (messageId: string, runId: string) => void
}

let idCounter = 0
export function generateId(prefix: string): string {
  idCounter++
  return `${prefix}-${Date.now()}-${idCounter}`
}

/**
 * Recover the ctx-pill values for a session that is becoming active. The
 * indicator reads `currentPromptTokens` and `currentResponseTokens` from
 * the chatStore — they are global state by design, but a session-load
 * must restore them so the pill reflects the loaded session's pressure
 * rather than whatever the previous session left.
 *
 * Two paths:
 *
 *  1. If the session has `lastPromptTokens` persisted (saved by
 *     `addTokenUsage`), use it directly — this is the authoritative value
 *     from the most recent assistant response's usage header.
 *
 *  2. Legacy sessions saved before v0.6.2 have no persisted count. Fall
 *     back to a char-based estimate: total message text ÷ 4 (rough
 *     tokens-per-char heuristic used widely as a pre-API approximation).
 *     The estimate is upper-bounded so a runaway session doesn't show
 *     a misleading 200% pressure on load; once the next turn lands, the
 *     real usage header replaces the estimate.
 */
function hydrateTokenCountsFromSession(session: ChatSession): { promptTokens: number; responseTokens: number } {
  if (typeof session.lastPromptTokens === 'number' && session.lastPromptTokens >= 0) {
    return {
      promptTokens: session.lastPromptTokens,
      responseTokens: session.lastResponseTokens ?? 0,
    }
  }
  // Legacy fallback — empty session shows 0%, non-empty shows an estimate.
  if (!session.messages || session.messages.length === 0) {
    return { promptTokens: 0, responseTokens: 0 }
  }
  let totalChars = 0
  for (const msg of session.messages) {
    const content: unknown = msg.content
    if (typeof content === 'string') {
      totalChars += content.length
    } else if (Array.isArray(content)) {
      for (const part of content as Array<{ type: string; text?: string }>) {
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          totalChars += part.text.length
        }
      }
    }
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'text' || block.type === 'reasoning') {
          totalChars += block.text.length
        }
      }
    }
  }
  const estimate = Math.round(totalChars / 4)
  return { promptTokens: estimate, responseTokens: 0 }
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

// === Draft persistence ===
//
// Per-session prompt drafts go to `.toquemedia/sessions/<sessionId>.draft.json`
// so a reload / crash / OS update never wipes a half-typed message. Save is
// debounced 600ms — short enough to capture before the user switches windows
// or quits the IDE, long enough to coalesce char-by-char typing into one
// write. On submit, `clearDraftOnDisk` is called explicitly to delete the
// file (separate from the empty-save-deletes path; reads cleaner at the
// call site, same end state).
//
// Resolves the project path and session id lazily — at schedule time we
// don't yet know the active session/project (chatStore hasn't been queried),
// so the actual save reads them inside the timer callback. If either is
// null at fire time the persist is a no-op (no project → no destination).
let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null
const DRAFT_PERSIST_DEBOUNCE_MS = 600

function persistDraftNow(): void {
  if (draftSaveTimeout) {
    clearTimeout(draftSaveTimeout)
    draftSaveTimeout = null
  }
  const state = useChatStore.getState()
  const sessionId = state.activeSessionId
  if (!sessionId) return
  const session = state.sessions.get(sessionId)
  if (!session?.projectPath) return
  void import('../services/draftPersistence').then(({ saveDraftToDisk }) =>
    saveDraftToDisk(session.projectPath, sessionId, {
      input: state.draftInput,
      attachments: state.draftAttachments,
    }),
  ).catch(() => { /* persistence is best-effort */ })
}

function scheduleDraftPersist(): void {
  // Empty drafts (the typical submit-cleared state) bypass the debounce
  // and persist immediately — otherwise a reload within the 600ms window
  // after submit would leave the OLD draft on disk and "resurrect" on
  // next open. For non-empty drafts the debounce coalesces char-by-char
  // typing into a single write.
  const state = useChatStore.getState()
  const isEmpty = !state.draftInput.trim() && state.draftAttachments.length === 0
  if (isEmpty) {
    persistDraftNow()
    return
  }
  if (draftSaveTimeout) clearTimeout(draftSaveTimeout)
  draftSaveTimeout = setTimeout(() => {
    draftSaveTimeout = null
    persistDraftNow()
  }, DRAFT_PERSIST_DEBOUNCE_MS)
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

  // CMD mode guard: the tool executor writes files directly to disk and
  // marks diffStatus='approved' via updateToolCallWithResult (alreadyApplied=true)
  // BEFORE this promise is created. Since CMD mode never populates pendingDiffs
  // and never shows an approval UI, nobody would call resolveDiffApproval —
  // the promise would block for 30 min. Check the toolCall's diffStatus and
  // resolve immediately if already approved.
  const session = useChatStore.getState().getActiveSession()
  if (session) {
    for (const msg of session.messages) {
      const tc = msg.toolCalls?.find(t => t.id === toolCallId)
      if (tc?.diffStatus === 'approved') {
        return true
      }
    }
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

// Track whether we're waiting for user action before flushing buffered deltas
let waitForUserFlush = false

/**
 * Check if any user-wait state is active that should pause streaming display.
 * Text arriving while the user is deciding on a permission/diff/credential
 * should be buffered until they respond, not shown immediately.
 */
function isAnyUserWaitStateActive(): boolean {
  try {
    // Lazy import to avoid circular dependency — permissionStore imports chatStore
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const permissionStore = require('../../stores/permissionStore').usePermissionStore
    const credentialStore = require('../../stores/credentialRequestStore').useCredentialRequestStore

    const hasPermission = !!permissionStore.getState().pendingPermission
    const hasDiffs = useChatStore.getState().pendingDiffs.length > 0
    const hasCredentials = credentialStore.getState().pending.size > 0

    return hasPermission || hasDiffs || hasCredentials
  } catch {
    // Stores not ready yet — don't block
    return false
  }
}

/**
 * Flush buffered deltas when user wait states clear. Called once when we
 * detect that the user has finished their action (approved/denied permission,
 * etc.) and we can resume showing streamed text.
 */
function flushWhenUserReady(): void {
  if (!waitForUserFlush) return
  if (isAnyUserWaitStateActive()) return

  waitForUserFlush = false
  flushBufferedDeltas()
}

// Subscribe to stores to detect when user wait states clear.
// Deferred to next tick to avoid "used before declaration" error since
// useChatStore is defined later in this file.
setTimeout(() => {
  try {
    // Lazy import to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const permissionStore = require('../../stores/permissionStore').usePermissionStore
    const credentialStore = require('../../stores/credentialRequestStore').useCredentialRequestStore

    permissionStore.subscribe(() => flushWhenUserReady())
    credentialStore.subscribe(() => flushWhenUserReady())
    useChatStore.subscribe((state, prevState) => {
      if (state.pendingDiffs.length !== prevState.pendingDiffs.length) {
        flushWhenUserReady()
      }
    })
  } catch {
    // Stores not ready yet — subscriptions will be set up when they are
  }
}, 0)

function scheduleFlush() {
  // If user is currently deciding on a permission/diff/credential, buffer
  // the text until they respond. This prevents the confusing UX of text
  // appearing in the chat while the user is trying to read a dialog.
  if (isAnyUserWaitStateActive()) {
    waitForUserFlush = true
    return
  }

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

// Per-result truncation when rebuilding the conversation history sent to the
// API. The toolExecutor already caps results at 30K via truncateResult (with a
// large_result reference for the model to recover full content); this second
// pass trims further to keep cumulative bytes manageable on long sessions.
// 4K was the original value but it dropped content the model had legitimately
// seen in the original turn (notably the `read_large_result` reference line at
// the tail of long results). 8K keeps the reference suffix intact for ~99% of
// the cases we saw in practice while still bounding session growth.
const MAX_TOOL_RESULT_CHARS = 8000

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
 *   - Assistant tool_calls → tool_call content blocks inside role:'assistant' content array
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
      // Build content blocks array
      const blocks: ContentBlockAPI[] = []

      // Thinking/reasoning → thinking block
      if (msg.reasoningContent) {
        blocks.push({ type: 'thinking', thinking: msg.reasoningContent })
      }

      // Text → text block
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content })
      }

      // Tool calls → tool_call blocks
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_call',
            id: tc.id,
            name: tc.toolName,
            arguments: JSON.stringify(tc.input || {}),
          })
        }
      }

      history.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : msg.content || '',
      })

      // Tool results → single user message with tool_result content blocks
      // (tool results are in role:'user' messages with tool_result content blocks)
      if (msg.toolCalls?.length) {
        const toolResultBlocks: ContentBlockAPI[] = []

        for (const tc of msg.toolCalls) {
          // Orphan tool call: agent was cancelled mid-execution
          if (tc.status === 'running' || tc.result === undefined) {
            toolResultBlocks.push({
              type: 'tool_result',
              toolCallId: tc.id,
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

          // Truncate large results. Surface the original size and an explicit
          // recovery hint so the model knows the tail it saw in the original
          // turn is gone from THIS rebuild — it can re-read the source or ask
          // the user for the relevant slice instead of silently making things
          // up about content it can no longer see.
          if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
            const origLen = resultContent.length
            resultContent =
              resultContent.slice(0, MAX_TOOL_RESULT_CHARS)
              + `\n\n<system-reminder>This tool result was ${origLen} chars in the original turn but only the first ${MAX_TOOL_RESULT_CHARS} are kept in this rebuilt history (~${origLen - MAX_TOOL_RESULT_CHARS} chars dropped). If reasoning about content past byte ${MAX_TOOL_RESULT_CHARS} matters for the current task, re-read the source (read_file / re-run the search) rather than guessing.</system-reminder>`
          }

          toolResultBlocks.push({
            type: 'tool_result',
            toolCallId: tc.id,
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
  // Snapshot of the most recent on-wire turn — persisted so the context
  // window indicator survives a session reload (without it, every reopen
  // flashes the bar to 0% until the next turn handshake repopulates the
  // live state).
  sessionService.setTurnSnapshotGetter(() => {
    const c = get()
    const a = useAgentStore.getState()
    if (c.currentPromptTokens === 0 && c.currentResponseTokens === 0 && a.modelContextWindow == null) {
      return null
    }
    return {
      promptTokens: c.currentPromptTokens,
      responseTokens: c.currentResponseTokens,
      contextWindow: a.modelContextWindow,
      modelName: a.modelName,
    }
  })

  return {
    sessions: new Map(),
    activeSessionId: null,
    isStreaming: false,
    isLoadingSession: false,
    streamingMessageId: null,
    streamingVersion: 0,
    conversationVersion: 0,
    postCompactSurveyPending: false,
    error: null,
    conversationHistory: [],
    currentTurnCount: 0,
    totalTokensUsed: { input: 0, output: 0 },
    currentPromptTokens: 0,
          currentResponseTokens: 0,
    agentStartTime: restoreAgentStartTime(),
    pendingDiffs: [],
    draftInput: '',
    draftAttachments: [],
    planRevisionPending: null,
    planResumePending: null,

    setDraftInput: (value: string) => {
      set({ draftInput: value })
      scheduleDraftPersist()
    },

    setPlanRevisionPending: (value: { projectPath: string; planPath?: string } | string | null) => set({ planRevisionPending: value }),

    setPlanResumePending: (value: PlanResumePending | null) => {
      set(state => {
        const sessionId = state.activeSessionId
        if (!sessionId) return { planResumePending: value }
        const sessions = new Map(state.sessions)
        const session = sessions.get(sessionId)
        if (session) {
          sessions.set(sessionId, {
            ...session,
            planResumePending: value,
            updatedAt: Date.now(),
          })
        }
        return { planResumePending: value, sessions }
      })
      sessionService.markDirty()
    },

    addDraftAttachment: (attachment: Attachment) => {
      set(state => {
        if (state.draftAttachments.length >= 10) return state
        // Deduplicate by path (skip for pasted images which have no path)
        if (attachment.path && state.draftAttachments.some(a => a.path === attachment.path)) return state
        return { draftAttachments: [...state.draftAttachments, attachment] }
      })
      scheduleDraftPersist()
    },

    removeDraftAttachment: (id: string) => {
      set(state => ({
        draftAttachments: state.draftAttachments.filter(a => a.id !== id)
      }))
      scheduleDraftPersist()
    },

    clearDraftAttachments: () => {
      set({ draftAttachments: [] })
      scheduleDraftPersist()
    },

    setPostCompactSurveyPending: (value: boolean) => {
      set({ postCompactSurveyPending: value })
    },

    setSessionMemory: (memory: string) => {
      set(state => {
        const sessionId = state.activeSessionId
        if (!sessionId) return state
        const sessions = new Map(state.sessions)
        const session = sessions.get(sessionId)
        if (session) {
          sessions.set(sessionId, { ...session, sessionMemory: memory, updatedAt: Date.now() })
        }
        return { sessions }
      })
      sessionService.markDirty()
    },

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
        byokSnapshot: captureByokSnapshot(),
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
          currentPromptTokens: 0,
          currentResponseTokens: 0,
          planResumePending: null,
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
      const session = get().sessions.get(sessionId)
      // Hydrate the ctx-pill state from the session. `currentPromptTokens`
      // is global state that the indicator reads — without this step, a
      // freshly-loaded session shows whatever the previous session left
      // (or 0% if first session of the app run), regardless of how much
      // history it actually carries. Restore from the persisted last-known
      // counts; fall back to a char-based estimate for legacy sessions
      // saved before v0.6.2 (no lastPromptTokens field on disk).
      const hydrated = session ? hydrateTokenCountsFromSession(session) : null
      set({
        activeSessionId: sessionId,
        currentPromptTokens: hydrated?.promptTokens ?? 0,
        currentResponseTokens: hydrated?.responseTokens ?? 0,
        // Reset draft to empty before async load — prevents the previous
        // session's draft from briefly flashing in the prompt bar while the
        // disk read is in flight. The hydration below replaces these if a
        // draft is found; otherwise the user sees the correct "no draft"
        // state immediately.
        draftInput: '',
        draftAttachments: [],
        planResumePending: session?.planResumePending ?? null,
      })
      // Re-scope the queue log to the newly-active session.
      if (session) setQueueLogContext(session.projectPath, sessionId)
      // Rehydrate any queued prompts that survived a previous crash/quit.
      // Loaded AFTER setQueueLogContext so a subsequent enqueue (e.g. from
      // a buffered user input) lands with the right (project, session)
      // stamped on every operation log line. The hydrate itself bypasses
      // the operation log to avoid replaying 100 fake "enqueue" entries
      // every IDE reopen.
      if (session?.projectPath) {
        void (async () => {
          const [{ loadQueueSnapshot }, { hydrateCommandQueue }] = await Promise.all([
            import('../services/agent/queueSnapshotPersistence'),
            import('../services/agent/messageQueue'),
          ])
          const items = await loadQueueSnapshot(session.projectPath, sessionId)
          if (items.length === 0) return
          // Re-check the session is still active — the user might have
          // switched again during the async I/O. If they did, the new
          // setActiveSession will fire its own hydrate; we don't want
          // ours to overwrite it.
          if (useChatStore.getState().activeSessionId !== sessionId) return
          hydrateCommandQueue(items)
        })().catch(() => { /* non-fatal */ })

        // Rehydrate invokedSkills — the post-compaction recovery payload
        // that survives across an IDE reload. Without this, a long
        // multi-skill session that reloads loses authoritative skill
        // content for re-injection on the next turn after compaction.
        void (async () => {
          const [{ loadInvokedSkillsFromDisk }, { hydrateInvokedSkills }] = await Promise.all([
            import('../services/agent/invokedSkillsPersistence'),
            import('../services/agent/skillService'),
          ])
          const skills = await loadInvokedSkillsFromDisk(session.projectPath, sessionId)
          if (skills.length === 0) return
          if (useChatStore.getState().activeSessionId !== sessionId) return
          hydrateInvokedSkills(skills)
        })().catch(() => { /* non-fatal */ })
      }
      // Hydrate the draft for this session from disk. Async — if the user
      // started typing in the new session before this resolves, their
      // typing wins (the disk draft was from a previous run anyway, less
      // recent than the live input). We guard against that by checking
      // the still-active session id AND that the live draft is still empty.
      if (session?.projectPath) {
        void import('../services/draftPersistence').then(async ({ loadDraftFromDisk }) => {
          const loaded = await loadDraftFromDisk(session.projectPath, sessionId)
          if (!loaded) return
          const stillActive = useChatStore.getState().activeSessionId === sessionId
          if (!stillActive) return
          const live = useChatStore.getState()
          if (live.draftInput || live.draftAttachments.length > 0) return
          set({ draftInput: loaded.input, draftAttachments: loaded.attachments })
        }).catch(() => { /* non-fatal */ })
      }
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

        const isFirstMessage = session.messages.length === 0 && !session.name
        const updatedSession: ChatSession = {
          ...session,
          messages: [...session.messages, message],
          status: 'running',
          updatedAt: Date.now(),
          ...(isFirstMessage && { name: content.slice(0, 80) }),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        // Reset both counters inside the same `set` so the indicators flip
        // to "hidden" on the very same render that draws the new user
        // bubble (no momentary stale flash carried over from the previous
        // turn). One source of truth for "a new user message starts a
        // fresh token budget for the UI" — covers chat-mode AND slash
        // command paths.
        return {
          sessions: updatedSessions,
          totalTokensUsed: { input: 0, output: 0 },
          currentPromptTokens: 0,
          currentResponseTokens: 0,
        }
      })

      debouncedSave()
      return messageId
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

    splitForQueuedMessage: (content: string, attachments?: Attachment[], promptBlocks?: PromptBlock[]) => {
      // Drain pending text/reasoning deltas to the OLD message before we
      // change streamingMessageId — otherwise late buffered chunks would
      // bleed into the new bubble.
      flushBufferedDeltas()

      const userMessageId = generateId('msg')
      const userMessage: ChatMessage = {
        id: userMessageId,
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments: attachments?.length ? attachments : undefined,
        promptBlocks: promptBlocks?.length ? promptBlocks : undefined,
      }

      const newAssistantId = generateId('msg')
      const newAssistant: ChatMessage = {
        id: newAssistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        codeBlocks: [],
        toolCalls: [],
        contentBlocks: [],
        isStreaming: true,
      }

      set(state => {
        const { activeSessionId, streamingMessageId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        // Finalise the current streaming assistant in place — same shape
        // as finalizeAssistantMessage but without resetting streaming state
        // (we are about to start streaming again into newAssistant).
        const messages = session.messages.map(msg => {
          if (msg.id !== streamingMessageId) return msg
          const reasoningDurationMs = msg.reasoningStartedAt && !msg.reasoningDurationMs
            ? Date.now() - msg.reasoningStartedAt
            : msg.reasoningDurationMs
          return {
            ...msg,
            isStreaming: false,
            isReasoningVisible: false,
            ...(reasoningDurationMs !== undefined && { reasoningDurationMs }),
          }
        })

        // Append user message + new streaming assistant at the end.
        messages.push(userMessage, newAssistant)

        const updatedSession: ChatSession = {
          ...session,
          messages,
          status: 'running',
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return {
          sessions: updatedSessions,
          // isStreaming stays true — the agent loop is still active and will
          // emit deltas into newAssistantId starting next turn.
          streamingMessageId: newAssistantId,
        }
      })

      debouncedSave()
      return newAssistantId
    },

    addSystemMessage: (content: string, level?: SystemMessageLevel, options?: { ephemeral?: boolean; timeoutMs?: number }) => {
      const messageId = generateId('msg')
      const ephemeral = options?.ephemeral === true
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content,
        timestamp: Date.now(),
        ...(level && { level }),
        ...(ephemeral && { ephemeral: true }),
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

      // Ephemeral messages auto-remove after a short delay. Default 8s gives
      // the user time to read the line before it scrolls + fades. Callers can
      // override via `timeoutMs` for messages that need longer dwell.
      // Note: removeMessage is a no-op if the user already navigated to a
      // different session — safe to fire-and-forget.
      if (ephemeral) {
        const ms = options?.timeoutMs ?? 8000
        setTimeout(() => {
          // Use getState() so the timer fires against whatever the store is
          // at that moment, not a stale closure over the addSystemMessage time.
          useChatStore.getState().removeMessage(messageId)
        }, ms)
      }
    },

    addTerminalCommandResult: (command: string, output: string, exitCode: number) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        level: exitCode === 0 ? 'success' : 'error',
        content: output,
        terminalCommand: { command, output, exitCode },
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

    addCompactBoundaryMessage: (beforeTokens: number, trigger: CompactMetadata['trigger'] = 'auto', messagesSummarized?: number) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        kind: 'compact_boundary',
        compactBeforeTokens: beforeTokens,
        compactMetadata: { trigger, beforeTokens, messagesSummarized },
        level: 'info',
        content: `Conversa comprimida (${Math.round(beforeTokens / 1000)}K tokens).`,
        timestamp: Date.now(),
      }

      set(state => {
        const { activeSessionId, sessions, streamingMessageId } = state
        if (!activeSessionId) {
          // No active session: still zero out the counter so the indicator
          // doesn't stay pinned at the pre-compression peak in stray UI.
          return { totalTokensUsed: { input: 0, output: state.totalTokensUsed.output }, currentPromptTokens: 0, currentResponseTokens: 0 }
        }

        const session = sessions.get(activeSessionId)
        if (!session) {
          return { totalTokensUsed: { input: 0, output: state.totalTokensUsed.output }, currentPromptTokens: 0, currentResponseTokens: 0 }
        }

        // Compaction can fire MID-LOOP — agentRunner creates the assistant
        // message once at request start (agentRunner.ts:157) and the same
        // `streamingMessageId` persists across every internal turn. If
        // compression triggers on turn 2+, the in-flight assistant bubble
        // already sits in `session.messages`; appending the boundary at the
        // end would put the bubble BEFORE the marker, and ChatView slices
        // on the latest boundary (chat/views/ChatView.tsx) — so the bubble
        // (and every subsequent delta written to it) would vanish from the
        // transcript. Insert the boundary IMMEDIATELY BEFORE the streaming
        // assistant when one exists so the bubble lives in the post-
        // boundary slice and stays visible. No streaming bubble → append
        // at the tail like before.
        let newMessages: ChatMessage[]
        const streamingIdx = streamingMessageId
          ? session.messages.findIndex(m => m.id === streamingMessageId)
          : -1
        if (streamingIdx >= 0) {
          newMessages = session.messages.slice()
          newMessages.splice(streamingIdx, 0, message)
        } else {
          newMessages = [...session.messages, message]
        }

        // Trim pre-boundary messages from the store so the UI updates
        // immediately without relying on ChatView's slice logic (which
        // can lag behind during active streaming). Keep the boundary
        // message itself and everything after it (including the in-flight
        // streaming assistant message).
        const boundaryIdx = newMessages.findIndex(m => m.id === messageId)
        if (boundaryIdx > 0) {
          newMessages = newMessages.slice(boundaryIdx)
        }

        const updatedSession: ChatSession = {
          ...session,
          messages: newMessages,
          // Compaction is the ONLY legitimate path that drops the session
          // peak. `addTokenUsage` now takes Math.max(previousPeak, newPrompt)
          // so the pill never decreases on its own (microcompaction shrinks
          // the wire prompt but the user's mental model is conversation-
          // scoped — see the comment in addTokenUsage). The explicit reset
          // here tells the pill the conversation footprint has genuinely
          // shrunk; without it the ctx indicator would stay pinned at the
          // pre-compaction peak forever.
          lastPromptTokens: 0,
          lastResponseTokens: 0,
          updatedAt: Date.now(),
        }

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)

        return {
          sessions: updatedSessions,
          totalTokensUsed: { input: 0, output: state.totalTokensUsed.output },
          currentPromptTokens: 0,
          currentResponseTokens: 0,
          conversationVersion: state.conversationVersion + 1,
          postCompactSurveyPending: Math.random() < 0.2,
        }
      })
    },

    syncByokSnapshot: () => {
      const next = captureByokSnapshot()
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state
        const session = sessions.get(activeSessionId)
        if (!session) return state
        // Skip if the snapshot is structurally unchanged — avoids
        // re-renders + disk writes when the user toggles unrelated state.
        const prev = session.byokSnapshot ?? null
        if (
          (prev === null && next === null) ||
          (prev && next &&
            prev.providerId === next.providerId &&
            prev.modelId === next.modelId &&
            prev.baseURL === next.baseURL &&
            prev.custom === next.custom)
        ) {
          return state
        }
        const updatedSession: ChatSession = {
          ...session,
          byokSnapshot: next,
          updatedAt: Date.now(),
        }
        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, updatedSession)
        return { sessions: updatedSessions }
      })
      debouncedSave()
    },

    startAssistantMessage: (thinkingRequested) => {
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
        ...(thinkingRequested !== undefined && { thinkingRequested }),
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

    toggleReasoningBlock: (messageId: string, blockIdx: number) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          const blocks = msg.contentBlocks
          if (!blocks || blockIdx < 0 || blockIdx >= blocks.length) return msg
          const target = blocks[blockIdx]
          if (target.type !== 'reasoning') return msg
          // First toggle on a block without explicit state inherits the
          // current message-level flag, then flips. That way the first
          // click on any block matches what the user was seeing (collapsed
          // by default, or expanded if isReasoningVisible was true).
          const currentVisible = target.isVisible ?? !!msg.isReasoningVisible
          const newBlocks = blocks.map((b, i) =>
            i === blockIdx && b.type === 'reasoning'
              ? { ...b, isVisible: !currentVisible }
              : b
          )
          return { ...msg, contentBlocks: newBlocks }
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

    appendToolCallCommandLog: (toolId: string, logChunk: string) => {
      const { activeSessionId, streamingMessageId, sessions } = get()
      if (!activeSessionId || !streamingMessageId) return

      const session = sessions.get(activeSessionId)
      if (!session) return

      const msg = session.messages.find(m => m.id === streamingMessageId)
      if (!msg || !msg.toolCalls) return

      const idx = msg.toolCalls.findIndex(t => t.id === toolId)
      if (idx < 0) return

      const existing = msg.toolCalls[idx].commandLogs || []
      // Cap at 500 lines to prevent memory bloat from verbose commands.
      // Older lines are dropped — the last N lines are the most useful.
      const MAX_LOG_LINES = 500
      const newLogs = [...existing, logChunk]
      const trimmed = newLogs.length > MAX_LOG_LINES ? newLogs.slice(-MAX_LOG_LINES) : newLogs

      const newToolCalls = msg.toolCalls.slice()
      newToolCalls[idx] = { ...newToolCalls[idx], commandLogs: trimmed }
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
            let diffPath: string | undefined

            try {
              const parsed = JSON.parse(result)
              if (parsed.type === 'diff') {
                diffPath = parsed.path
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

            const mergedInput = diffPath && !toolCalls[i].input?.file_path && !toolCalls[i].input?.path
              ? { ...toolCalls[i].input, file_path: diffPath }
              : toolCalls[i].input

            toolCalls[i] = {
              ...toolCalls[i],
              input: mergedInput,
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

        // Capture per-turn stats for the assistant footer (CMD mode shows
        // a "✓ 2.3s · ↑12k ↓4k" summary line below each completed reply).
        // tokens here is the per-REQUEST counter — addTokenUsage accumulates
        // across tool loops within the same turn — so it represents the
        // cost of producing this single assistant message, not the session
        // total. `input` is max-across-turns (context size on the wire),
        // `output` is sum (deltas emitted). They are different units; the
        // footer shows them separately for that reason.
        const turnDurationMs = state.agentStartTime !== null
          ? Date.now() - state.agentStartTime
          : undefined
        const turnInputTokens = state.totalTokensUsed.input
        const turnOutputTokens = state.totalTokensUsed.output

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
            ...(turnDurationMs !== undefined && { turnDurationMs }),
            ...(turnInputTokens > 0 && { turnInputTokens }),
            ...(turnOutputTokens > 0 && { turnOutputTokens }),
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

        return {
          sessions,
          activeSessionId,
          conversationHistory: [],
          currentTurnCount: 0,
          planResumePending: state.activeSessionId === sessionId ? null : state.planResumePending,
        }
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
          currentPromptTokens: 0,
          currentResponseTokens: 0,
          planResumePending: null,
        }
      })
      // Mark dirty so the cleared state is persisted
      sessionService.markDirty()
    },

    replaceMessages: (messages: ChatMessage[]) => {
      set(state => {
        const sessionId = state.activeSessionId
        if (!sessionId) return state
        const sessions = new Map(state.sessions)
        const session = sessions.get(sessionId)
        if (session) {
          sessions.set(sessionId, {
            ...session,
            messages,
            updatedAt: Date.now(),
          })
        }
        return { sessions, currentTurnCount: 0 }
      })
      sessionService.markDirty()
    },

    replaceConversationHistory: (newHistory: ConversationMessage[]) => {
      set(state => {
        const sessionId = state.activeSessionId
        if (!sessionId) return state
        const sessions = new Map(state.sessions)
        const session = sessions.get(sessionId)
        if (!session) return state

        // Convert ConversationMessage[] → ChatMessage[]
        const chatMessages: ChatMessage[] = newHistory.map((m, i) => ({
          id: generateId('msg'),
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map(b => ('text' in b ? b.text : '')).join('')
              : '',
          timestamp: Date.now() + i,
        }))

        sessions.set(sessionId, {
          ...session,
          messages: chatMessages,
          updatedAt: Date.now(),
        })

        return {
          sessions,
          conversationHistory: newHistory,
          currentTurnCount: 0,
        }
      })
      sessionService.markDirty()
    },

    resetTokenCounters: () => {
      set(state => {
        // Also reset lastPromptTokens on the active session so the
        // ContextWindowIndicator doesn't fall back to stale pre-compact values.
        const sessionId = state.activeSessionId
        const sessions = sessionId ? new Map(state.sessions) : state.sessions
        if (sessionId) {
          const session = sessions.get(sessionId)
          if (session) {
            sessions.set(sessionId, { ...session, lastPromptTokens: 0 })
          }
        }
        return {
          totalTokensUsed: { input: 0, output: state.totalTokensUsed.output },
          currentPromptTokens: 0,
          currentResponseTokens: 0,
          sessions,
        }
      })
    },

    updateConversationHistory: (messages: ConversationMessage[]) => {
      set({ conversationHistory: messages })
    },

    incrementTurnCount: () => {
      set(state => ({ currentTurnCount: state.currentTurnCount + 1 }))
    },

    addTokenUsage: (input: number, output: number) => {
      // Three counters, three semantics. Get this right or the UI lies in
      // ways that take a user-reported "904k tokens sent to a 256k window"
      // to root-cause.
      //
      //   totalTokensUsed.input: MAX(prev, newInput) across the turns of
      //     the current user message. Every agent-loop iteration re-sends
      //     the full conversation history, so each iteration's input
      //     ALREADY contains the previous iterations' inputs. Summing
      //     produces double-count (n turns × ~history-size = inflated
      //     total; this is what gave a real user "↑ 904k" while the actual
      //     context-pressure pill read 15 % of 256 K = 38 K). MAX is the
      //     peak wire-size during the request — bounded by the context
      //     window AND robust to mid-request compaction shrinking the
      //     prompt. The activity indicator ("↑ Nk") shows this.
      //
      //   totalTokensUsed.output: SUMMED across turns. Each turn emits
      //     NEW output tokens (not history echo), so summing is the real
      //     "tokens we generated this request".
      //
      //   currentPromptTokens: WITHIN A TURN, monotonically grows via
      //     Math.max — the size of the prompt on the wire only ever
      //     increases as more events stream in. The natural denominator
      //     for the context-window pressure pill (X % of 256 K). Reset
      //     to 0 between turns by `resetTokenUsage` (called from
      //     `agentRunner` at request start) AND by the compaction marker
      //     handler — both points are the only places it can decrease.
      //     Compaction shrinkage is therefore still visible to the pill
      //     because the reset happens explicitly before the next turn's
      //     `message_start` lands.
      //
      // Anti-overwrite guards. OpenAI streaming sends usage info in the
      // final chunk: `prompt_tokens` and `completion_tokens` are both
      // present in the last usage object. However, some BYOK adapters
      // (such as DashScope GLM-5.1, OpenRouter Mimo) may send partial
      // usage data. Math.max + the `> 0` guard between them: zero never wins
      // (claude-vaz parity, services/api/claude.ts:2918-2922), and a
      // non-zero smaller value never replaces a non-zero larger one.
      // Output is always a fresh per-turn value, so it overwrites
      // unconditionally.
      set(state => {
        const nextPrompt =
          input > 0
            ? Math.max(state.currentPromptTokens, input)
            : state.currentPromptTokens
        const nextResponse = output
        // Persist last-known token counts onto the active session so the
        // ctx pill restores correctly when the user reopens this session
        // in a future app run. Without this, currentPromptTokens is global
        // state and a freshly-loaded session shows 0% even with 50 turns
        // of accumulated history.
        let nextSessions = state.sessions
        if (state.activeSessionId) {
          const active = state.sessions.get(state.activeSessionId)
          if (active) {
            nextSessions = new Map(state.sessions)
            // Session-level peak: take the MAX of the new per-turn prompt
            // and whatever was already persisted. This is the value the
            // ctx pill falls back to when `currentPromptTokens` is 0
            // between turns. Without the MAX guard, a new turn whose
            // wire-input is smaller than the previous (microcompaction
            // dropped old tool results, or a sub-agent ran with a
            // smaller prompt) would overwrite the session peak — which
            // produced the visible "34 % → 7 % → 33 %" regression a
            // user reported during a #auth-* flow with a sub-agent
            // verifier in the middle. The peak is reset explicitly
            // ONLY by the compaction marker handler (~line 1188 above).
            const previousPeak = active.lastPromptTokens ?? 0
            const nextPeak = Math.max(previousPeak, nextPrompt)
            nextSessions.set(state.activeSessionId, {
              ...active,
              lastPromptTokens: nextPeak,
              lastResponseTokens: nextResponse,
              updatedAt: Date.now(),
            })
          }
        }
        return {
          totalTokensUsed: {
            // MAX, not SUM. See header comment for the 904k-vs-38k bug
            // this prevents. `input > 0` guard piggy-backs on the same
            // anti-zero-overwrite logic as currentPromptTokens.
            input: input > 0 ? Math.max(state.totalTokensUsed.input, input) : state.totalTokensUsed.input,
            output: state.totalTokensUsed.output + output,
          },
          currentPromptTokens: nextPrompt,
          currentResponseTokens: nextResponse,
          sessions: nextSessions,
        }
      })
    },

    resetTokenUsage: () => {
      // Per-request reset: zero the current-turn counters so the ctx pill
      // doesn't show stale numbers while the next request streams. The
      // session-persisted lastPromptTokens / lastResponseTokens are NOT
      // touched — they're authoritative for "what was the context size at
      // the end of the last completed turn" and the indicator falls back
      // to them when the new turn hasn't produced usage data yet.
      set({
        totalTokensUsed: { input: 0, output: 0 },
        currentPromptTokens: 0,
        currentResponseTokens: 0,
      })
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
      if (session && session.messages.length > 0) {
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
        // but KEEP card messages (plan_approval, todo_list) which carry
        // actionable state, AND KEEP compact_boundary markers — those are
        // the slice point ChatView uses to hide pre-compression history
        // (ChatView.tsx:73-82). Dropping them on reload makes the
        // pre-compression turns reappear in the transcript as if the
        // compaction never happened, which is precisely the regression
        // claude-vaz solved by persisting `isCompactBoundaryMessage` with
        // a dedicated `isCompaction: true` flag.
        session.messages = session.messages.filter(m =>
          m.role !== 'system' || m.card || m.kind === 'compact_boundary'
        )

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

        // Read persisted token snapshot before the set() so we can restore
        // the indicator state in one shot rather than firing a second update
        // (the bar would otherwise tween from 0% on every session open).
        const snapshot = (session as ChatSession & { lastTurnSnapshot?: import('../types/chat').SessionTurnSnapshot }).lastTurnSnapshot ?? null

        // Mirror the snapshot values onto the session record itself so the
        // ContextWindowIndicator's fallback (currentPromptTokens === 0 →
        // session.lastPromptTokens) works on the very first turn after load.
        // Without this, `resetTokenUsage` (fired by agentRunner at the start
        // of every new request) zeros currentPromptTokens, the fallback hits
        // an undefined session field, and the pill collapses to 0% until the
        // new turn's message_start lands — the exact symptom reported on a
        // freshly-opened session with history.
        const sessionWithTokens: ChatSession =
          snapshot
            ? {
                ...session,
                lastPromptTokens: snapshot.promptTokens,
                lastResponseTokens: snapshot.responseTokens,
              }
            : session

        set(() => {
          // Only keep the loaded session in memory to avoid unbounded growth
          const sessions = new Map<string, ChatSession>()
          sessions.set(sessionWithTokens.id, sessionWithTokens)
          return {
            sessions,
            activeSessionId: sessionWithTokens.id,
            conversationHistory,
            currentTurnCount: 0,
            totalTokensUsed: { input: 0, output: 0 },
            currentPromptTokens: snapshot?.promptTokens ?? 0,
            currentResponseTokens: snapshot?.responseTokens ?? 0,
            pendingDiffs: [],
            planResumePending: sessionWithTokens.planResumePending ?? null,
          }
        })

        // Restore model identity + context window so the pill renders the
        // real % immediately. Use `undefined` for absent fields so
        // setModelInfo's "leave alone" semantics kick in for thinkingMode.
        if (snapshot && (snapshot.contextWindow != null || snapshot.modelName != null)) {
          useAgentStore.getState().setModelInfo(
            snapshot.modelName ?? null,
            null,
            undefined,
            snapshot.contextWindow,
          )
        }

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

      // Reset auto-approve state from any previous session. Without this,
      // approvedScopes (persisted in .toquemedia/permissions.json) and
      // autoApproveDiffs (localStorage) survive across app restarts,
      // causing the agent to skip ALL permission dialogs on boot.
      usePermissionStore.getState().resetAutoApprove()

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

        // Strip ephemeral system messages but keep card messages AND
        // compact_boundary markers (slice point used by ChatView to hide
        // pre-compression turns). Mirrors the same predicate in
        // loadSessionFromDisk.
        session.messages = session.messages.filter(m =>
          m.role !== 'system' || m.card || m.kind === 'compact_boundary'
        )
        if (session.messages.length === 0) return false

        const conversationHistory = rebuildConversationHistory(session.messages)

        // Initialize checkpoint service for this restored session
        await CheckpointService.getInstance().initSession(projectPath, session.id)
        if (isStale()) return false
        useCheckpointStore.getState().syncFromService()

        // Mirror loadSessionFromDisk: pull token counters + model identity
        // out of the persisted snapshot so the ContextWindowIndicator
        // doesn't flash 0% on the boot path (which goes through
        // restoreLastSession from App.tsx, NOT loadSessionFromDisk).
        const bootSnapshot = (session as ChatSession & { lastTurnSnapshot?: import('../types/chat').SessionTurnSnapshot }).lastTurnSnapshot ?? null

        const restoredSession: ChatSession =
          bootSnapshot
            ? {
                ...session,
                lastPromptTokens: bootSnapshot.promptTokens,
                lastResponseTokens: bootSnapshot.responseTokens,
              }
            : session

        set(() => {
          const sessions = new Map<string, ChatSession>()
          sessions.set(restoredSession.id, restoredSession)
          return {
            sessions,
            activeSessionId: restoredSession.id,
            conversationHistory,
            currentTurnCount: 0,
            totalTokensUsed: { input: 0, output: 0 },
            currentPromptTokens: bootSnapshot?.promptTokens ?? 0,
            currentResponseTokens: bootSnapshot?.responseTokens ?? 0,
            pendingDiffs: [],
            planResumePending: restoredSession.planResumePending ?? null,
          }
        })

        // Restore model identity + context window so the ctx pill renders
        // its real % from the very first paint. Identical wiring to
        // loadSessionFromDisk so both entry paths converge on the same
        // post-load shape.
        if (bootSnapshot && (bootSnapshot.contextWindow != null || bootSnapshot.modelName != null)) {
          useAgentStore.getState().setModelInfo(
            bootSnapshot.modelName ?? null,
            null,
            undefined,
            bootSnapshot.contextWindow,
          )
        }

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
          currentPromptTokens: 0,
          currentResponseTokens: 0,
          pendingDiffs: [],
          planResumePending: null,
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
            currentPromptTokens: 0,
          currentResponseTokens: 0,
            pendingDiffs: [],
            planResumePending: null,
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
      // Save current session with token usage (skip empty sessions)
      const state = get()
      const session = state.getActiveSession()
      if (session && session.messages.length > 0) {
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
      // Reset to the canonical initial state. Previous version omitted
      // isLoadingSession (could leave the loading skeleton stuck after a
      // project delete that fired mid-load), error (stale "BYOK key missing"
      // / 402 / 5xx banner from the deleted project lingering on the empty
      // welcome screen), streamingVersion (cosmetic counter), and — most
      // user-visible — draftAttachments (image chips the user had pinned to
      // the prompt input would carry over to the next project they opened).
      set({
        sessions: new Map(),
        activeSessionId: null,
        conversationHistory: [],
        isStreaming: false,
        isLoadingSession: false,
        streamingMessageId: null,
        streamingVersion: 0,
        conversationVersion: 0,
        postCompactSurveyPending: false,
        error: null,
        agentStartTime: null,
        currentTurnCount: 0,
        totalTokensUsed: { input: 0, output: 0 },
        currentPromptTokens: 0,
          currentResponseTokens: 0,
        pendingDiffs: [],
        draftInput: '',
        draftAttachments: [],
      })
    },

    // === Card messages (plan approval, todo list) ===

    addCardMessage: (
      type: ChatMessageCard['type'],
      projectPath: string,
      metadata?: Pick<ChatMessageCard, 'planPath' | 'planFileName'>,
    ) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content: '',
        timestamp: Date.now(),
        card: { type, projectPath, status: 'pending', ...metadata },
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

    addAskUserQuestionCard: (projectPath, requestId, questions) => {
      const messageId = generateId('msg')
      const message: ChatMessage = {
        id: messageId,
        role: 'system',
        content: '',
        timestamp: Date.now(),
        card: {
          type: 'ask_user_question',
          projectPath,
          status: 'pending',
          requestId,
          questions,
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

    removeMessage: (messageId) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.filter(msg => msg.id !== messageId)
        if (messages.length === session.messages.length) return state

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })

        return { sessions: updatedSessions }
      })

      debouncedSave()
    },

    appendSubAgentRunId: (messageId, runId) => {
      set(state => {
        const { activeSessionId, sessions } = state
        if (!activeSessionId) return state

        const session = sessions.get(activeSessionId)
        if (!session) return state

        const messages = session.messages.map(msg => {
          if (msg.id !== messageId) return msg
          const existing = msg.subAgentRunIds || []
          if (existing.includes(runId)) return msg
          return { ...msg, subAgentRunIds: [...existing, runId] }
        })

        const updatedSessions = new Map(sessions)
        updatedSessions.set(activeSessionId, { ...session, messages, updatedAt: Date.now() })
        return { sessions: updatedSessions }
      })
    },
  }
})
