// === Chat Types ===

export type AttachmentType = 'image' | 'file' | 'folder'

export interface Attachment {
  id: string
  type: AttachmentType
  name: string
  path: string
  mimeType?: string
  sizeBytes?: number
  /** Base64 data URI — only for images (populated at attach-time for thumbnail preview) */
  base64?: string
  /**
   * Número do chip `[Image #N]` (paridade claude-vaz, history.ts:59) —
   * atribuído quando uma imagem é colada/anexada no CMD mode. O mesmo texto
   * é inserido no input; no submit, a imagem só é enviada se o placeholder
   * ainda estiver no texto (apagar o texto remove a imagem — claude-vaz
   * handlePromptSubmit.ts:178). Estável após atribuição: remoções de outros
   * anexos não renumeram.
   */
  pasteMarker?: number
}

/** Ordered content block — tracks interleaving of reasoning, text and tool
 *  calls in assistant messages. Used by the chat bubble for inline rendering.
 *  Reasoning is its own block type (not the message-level reasoningContent
 *  field) so multiple thinking passes within one assistant message render in
 *  the correct positions: e.g. `[reasoning, tool_call, tool_call, reasoning]`
 *  rather than collapsing every thinking pass into a single block at the top. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string }
  | {
      type: 'reasoning'
      text: string
      /** Set when the reasoning block ends (subsequent tool/text/reasoning arrives). */
      durationMs?: number
      /** Internal: epoch ms when the block was first created. Used to derive durationMs. */
      startedAt?: number
      /** Per-block expansion state. When undefined, falls back to the
       *  message-level `isReasoningVisible` flag (legacy behaviour).
       *  When defined, this overrides the message flag — set by
       *  `toggleReasoningBlock` so each reasoning block can be
       *  expanded independently of its siblings. */
      isVisible?: boolean
    }

/** Ordered prompt block — tracks the interleaving of user text and
 *  attachments in a SINGLE user message (or coalesced batch). The
 *  message queue carries this as `value`; the chat bubble derives
 *  `(text, attachments)` from it for display, and the agent boundary
 *  derives either an interleaved text prompt or an OpenAI content
 *  parts array depending on model capability. Defined here so both
 *  the queue layer and the chat store can produce/consume it without
 *  cross-imports. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: Attachment }

/** Message format for OpenAI-compatible conversation history */
/**
 * OpenAI / OpenAI-compatible content parts for multimodal user messages.
 *
 * Mirrors the shape consumed by vision-capable providers (Qwen3 Plus,
 * Kimi K2.5, Step3.5, etc.) via the backend proxy. Used wherever a
 * message's content can carry images interleaved with text — chiefly
 * the queue → agent boundary and the conversationHistory shape so
 * follow-up turns continue to see images from earlier turns.
 *
 * Defined in types/chat.ts (rather than agentService.ts) so the
 * stores layer can construct it without importing from a service.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

/**
 * OpenAI Chat Completion tool call — matches the format returned by
 * OpenAI-compatible providers.
 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Unified content block format for conversation history.
 * Supports both text-only and structured content (tool calls, reasoning, images).
 * This replaces the previous AnthropicContentBlock format.
 */
export type ContentBlockAPI =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string; thoughtSignature?: string }
  | { type: 'tool_result'; toolCallId: string; content: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

/** @deprecated Use ContentBlockAPI directly. Kept as alias for backward compatibility. */
export type AnthropicContentBlock = ContentBlockAPI

/**
 * Opaque provider-native state captured at turn completion.
 * Preserved for exact round-trip in subsequent turns — never
 * transformed into text or stripped of unknown fields.
 */
export interface ProviderState {
  /** Provider identifier (e.g. "dashscope", "mimo", "gemini") */
  provider: string
  /** Protocol family detected at request time */
  protocol: 'openai-chat' | 'anthropic' | 'openai-responses' | 'custom'
  /**
   * OpenAI Chat-compatible: complete assistant message as returned by the
   * provider. Includes role, content, reasoning_content, reasoning_details,
   * tool_calls, and any unknown fields. Deep copy — safe to serialize.
   */
  nativeAssistantMessage?: Record<string, unknown>
  /**
   * Anthropic: native content blocks including thinking, signature,
   * redacted_thinking, text, tool_use with IDs and unknown fields.
   * Reserved for future Anthropic protocol support.
   */
  nativeContentBlocks?: unknown[]
  /**
   * OpenAI Responses API: native output items including reasoning,
   * encrypted_content, function_call/output linkage, IDs.
   * Reserved for future Responses API support.
   */
  nativeResponseOutputItems?: unknown[]
  /** Epoch ms when captured */
  capturedAt?: number
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  /** String for text-only messages, ContentBlockAPI[] for structured messages
   *  (tool_call blocks, tool_result blocks, thinking blocks, image parts). */
  content: string | ContentBlockAPI[] | null
  /**
   * Provider-native fields for exact round-trip (assistant messages only).
   * Spread into the API request body by query.ts instead of reconstructing
   * from reasoningContent/contentBlocks. Undefined on legacy sessions.
   */
  _native?: Record<string, unknown>
}

export interface ToolCallDisplay {
  id: string
  toolName: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'running' | 'completed' | 'failed'
  /**
   * True once the tool actually BEGAN executing (set on onToolCallStart, which
   * fires right before toolExecutor.execute() in the serial tool loop). Tool
   * calls are added with status:'running' the moment they stream in
   * (addPendingToolCall), but the loop runs them one at a time and blocks on
   * each diff approval — so a turn that emits N edits shows the first one's
   * approval card while edits 2..N sit QUEUED behind it. Without this flag
   * they all render an active "editing" spinner, which reads as N parallel
   * edits firing at once (a confusing "race"). `started !== true` while
   * status==='running' means "queued, not yet started" → rendered as a calm
   * queued row instead of the active spinner.
   */
  started?: boolean
  timestamp: number
  // Diff data (populated for write_file and edit_file)
  diffOldContent?: string
  diffNewContent?: string
  isNewFile?: boolean
  diffStatus?: 'pending' | 'approved' | 'denied'
  diffResultId?: string
  /** Live progress text shown while tool is running (e.g., sub-agent status). */
  progressText?: string
  /** Accumulated log output from streaming commands (build, test, install, scripts).
   *  Rendered as a scrollable terminal-style log viewer. */
  commandLogs?: string[]
  /** Id of the parent tool call that spawned this one (research / verify / bg agent).
   *  When set, the UI renders this tool call with a nested indent + marker so the
   *  user sees the full sub-agent activity, not just a progress string. */
  spawnedBy?: string
  /** Permission decision recorded when the tool ran. Lets the session export
   *  distinguish auto-approved tools, user-approved tools, and denied tools.
   *  Without this, forensic review mistakes user-approved destructive commands
   *  for skill violations (the export only shows the final tool result, not
   *  the dialog the user actually saw). */
  permission?: {
    approved: boolean
    prompted: boolean
    source: 'safe_tool' | 'has_own_approval' | 'approved_scope' | 'user'
    promptKind?: import('../stores/permissionStore').PromptReason
    denyReason?: string
  }
}

export interface CredentialFieldDescriptor {
  id: string
  label: string
  type: 'text' | 'password'
  required: boolean
  helperText?: string
}

export interface ChatMessageCard {
  type: 'plan_approval' | 'todo_list' | 'credential_request' | 'permission_request' | 'ask_user_question'
  projectPath: string
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'submitted' | 'cancelled' | 'expired'
  /** plan_approval only: concrete plan file path when not the default project PLAN.md */
  planPath?: string
  /** plan_approval only: display/file basename for the concrete plan artefact */
  planFileName?: string
  /** credential_request only: identifies the pending entry in credentialRequestStore */
  requestId?: string
  /** credential_request only: service name (e.g. "OpenAI", "Stripe") shown in the form header */
  serviceName?: string
  /** credential_request only: fields to collect */
  fields?: CredentialFieldDescriptor[]
  /** credential_request only: keys actually submitted (no values) — populated after submit */
  submittedKeys?: string[]
  /** ask_user_question only: the questions to display */
  questions?: import('../stores/askUserQuestionStore').Question[]
  /** ask_user_question only: answers submitted by the user */
  answers?: Record<string, string | string[]>
  /** permission_request only: identifies the pending entry in permissionStore.
   *  When the user clicks Allow/Deny after a reload, the in-memory entry is
   *  gone — we use this id to detect the "stale card" path and instruct the
   *  user to resume via "Continue" instead of silently no-op'ing. */
  permissionId?: string
  /** permission_request only: tool whose execution is being gated. */
  toolName?: string
  /** permission_request only: snapshot of the tool args, truncated for display. */
  argsSummary?: string
  /** permission_request only: extra friction signal (sensitive file, dangerous
   *  command, browser action). Drives the UI emphasis ("requires approval"). */
  promptReason?: 'sensitive_file' | 'dangerous_command' | 'browser_action' | null
}

export type SystemMessageLevel = 'info' | 'success' | 'error' | 'warn'

/**
 * Discriminator for special system messages whose rendering differs from the
 * default bullet+text layout (compact boundary, future kinds).
 *
 * - `compact_boundary`: marks the point where the agent compressed the
 *   conversation. Renders as a claude-vaz-style horizontal rule with the
 *   "✻ Conversa comprimida" label, and the ChatView hides every message
 *   above the latest boundary (pre-compression history stays in storage
 *   but is folded away from the transcript — same as claude-vaz).
 */
export type SystemMessageKind = 'compact_boundary'

/** Metadata stored on compact_boundary messages for richer rendering. */
export interface CompactMetadata {
  trigger: 'auto' | 'manual' | 'reactive'
  beforeTokens: number
  messagesSummarized?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  /** For role === 'system': semantic level used for colour-coding in the terminal UI */
  level?: SystemMessageLevel
  /** For role === 'system': discriminator for special rendering (e.g., compact boundary). */
  kind?: SystemMessageKind
  /** Optional pre-compression token count, set on compact_boundary messages. */
  compactBeforeTokens?: number
  /** Richer metadata for compact_boundary messages (trigger, token count, messages summarized). */
  compactMetadata?: CompactMetadata
  /** Terminal-mode local command result, rendered like a shell command block. */
  terminalCommand?: {
    command: string
    output?: string
    exitCode: number
  }
  content: string
  timestamp: number
  codeBlocks?: CodeBlock[]
  toolCalls?: ToolCallDisplay[]
  /** Ordered sequence of text and tool-call blocks for interleaved rendering */
  contentBlocks?: ContentBlock[]
  isStreaming?: boolean
  // Reasoning (collapsible)
  reasoningContent?: string
  isReasoningVisible?: boolean
  /** Epoch ms when first reasoning delta arrived */
  reasoningStartedAt?: number
  /** Duration in ms of the reasoning phase */
  reasoningDurationMs?: number
  /**
   * Did the developer ask for reasoning on the request that produced this
   * assistant message?
   *
   * - `true`  → user toggled thinking ON (non-BYOK plans) OR fired a
   *             reasoning command (/plan, /debug, /review, /te2e). The
   *             reasoning blocks render normally.
   * - `false` → BYOK in play OR toggle OFF AND no reasoning command. Even
   *             if the model produces reasoning (BYOK reasoning models often
   *             always think regardless of `reasoning_effort: 'minimal'`),
   *             the IDE suppresses the blocks in the UI — the developer
   *             asked for code, not for a chain-of-thought dump.
   * - `undefined` → legacy session from before the flag existed. Render as
   *             before (no behavioural change for old data).
   */
  thinkingRequested?: boolean
  /**
   * Opaque provider-native state captured at turn completion. When present,
   * rebuildConversationHistory uses this as the source of truth for the
   * assistant message in subsequent turns instead of reconstructing from
   * reasoningContent/contentBlocks. Undefined on legacy sessions — the
   * legacy reasoningContent fallback path is used instead.
   */
  providerState?: ProviderState
  /**
   * One ProviderState per INTERNAL turn of the agent loop, in order. A single
   * user request can produce N assistant turns (text→tools→text→tools→final),
   * all collapsed into one ChatMessage bubble; `providerState` alone keeps
   * only the LAST turn, so rebuilding history from it advertises only the
   * last turn's tool_calls while toolCalls[] holds every turn's calls — the
   * mismatch silently dropped intermediate tool results and reasoning from
   * the model's context (context pollution audit, 2026-06-12). When present,
   * rebuildConversationHistory emits one assistant+tool_results pair per
   * entry. `providerState` is kept as the last entry for back-compat with
   * sessions persisted before this field existed.
   */
  providerStates?: ProviderState[]
  /** Inline card (plan approval, todo list) */
  card?: ChatMessageCard
  /** Attachments included with this message (metadata only — content is resolved into message.content at send-time) */
  attachments?: Attachment[]
  /**
   * Synthetic tool-call context resolved from @-mentions (and the
   * external-modification sweep) on this USER message — the
   * `<system-reminder>` blocks appended after the prompt at send-time.
   * Persisted so rebuildConversationHistory re-emits it on follow-up turns;
   * claude-vaz keeps attachment messages in the transcript and without this
   * field the mentioned-file content would evaporate from the model's view
   * after the first turn. Never rendered in the chat bubble.
   */
  mentionContext?: string
  /** Absolute paths of the file-content snapshots frozen in mentionContext.
   *  rebuildConversationHistory voids the snapshot for any path a later tool
   *  call superseded, so the model never sees a stale @-mention body
   *  contradicting a fresh tool result (context pollution audit, 2026-06-12). */
  mentionedPaths?: string[]
  /**
   * Original interleaved order of text and attachments at enqueue/send
   * time. When present, this is the canonical source for reconstructing
   * the message: rebuildConversationHistory walks promptBlocks in order
   * to produce content parts that preserve the user's original sequence
   * (vs the lossy text-then-attachments fallback derived from
   * `content` + `attachments`). Stripped of base64 at disk persistence;
   * in-memory image blocks carry base64 for follow-up turn fidelity.
   */
  promptBlocks?: PromptBlock[]
  /** Per-turn footer stats — captured at finalize time on assistant
   *  messages so the UI can show "how long did this turn take, and how
   *  many tokens did it consume" below the message. */
  turnDurationMs?: number
  turnInputTokens?: number
  turnOutputTokens?: number
  /**
   * Ephemeral system messages: appear momentarily in the transcript, scroll
   * up as new messages arrive, and auto-remove after a short timeout. Used
   * for transient status (permission grants, "session saved", dev-server
   * lifecycle) where the event itself is interesting but not worth keeping
   * in the conversation history. Not persisted to disk (sanitizer drops them).
   */
  ephemeral?: boolean
  /** Sub-agent run IDs spawned by task() tool calls in this message. SubAgentCard renders for each. */
  subAgentRunIds?: string[]
}

export interface CodeBlock {
  id: string
  language: string
  code: string
  filePath?: string
  status: 'pending' | 'applied' | 'rejected'
}

export interface ChatSession {
  id: string
  name?: string
  projectPath: string
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  createdAt: number
  updatedAt: number
  /** BYOK snapshot taken at session creation. Frozen for the lifetime of
   *  the session — switching the global active provider in Settings does
   *  NOT migrate active sessions. Null when the session was created
   *  without BYOK (TMS-routed). */
  byokSnapshot?: ByokSessionSnapshot | null
  /** Last known input-token count for the next turn, captured from the
   *  most recent assistant response's usage header. Persisted with the
   *  session so the context-window indicator restores correct pressure
   *  when the user reopens the session in a future app run.
   *  Missing on legacy sessions (pre-v0.6.2) — the loader falls back to
   *  a char-based estimate from the message history. */
  lastPromptTokens?: number
  lastResponseTokens?: number
  /** Session-scoped memory notes maintained by the agent via
   *  `update_session_memory`. Survives context compaction but resets on
   *  new session creation. The agent uses these to track in-progress work,
   *  decisions made, and pending next steps. */
  sessionMemory?: string
  /**
   * Incomplete /plan run that should be resumed in architect mode on the next
   * user message. This prevents a plain "continue" after an interrupted plan
   * from falling through to the default coding agent and implementing files.
   */
  planResumePending?: PlanResumePending | null
}

export interface PlanResumePending {
  projectPath: string
  originalArgs: string
  planPath: string
  planFileName: string
  mode: 'chat' | 'terminal'
  updatedAt: number
}

/** Per-session frozen reference to the BYOK selection at creation time.
 *  Stored on disk alongside the session so reloads use the same provider/
 *  model that the conversation started with. */
export interface ByokSessionSnapshot {
  providerId: string
  modelId: string
  /** Resolved baseURL (override or provider default) at snapshot time. */
  baseURL: string
  /** Whether the provider is `custom`. Drives the X-BYOK-Capabilities
   *  header inclusion on each request. */
  custom: boolean
  /** Whether the provider is `local` (Ollama, LM Studio). Critical for the
   *  agentService routing decision: local providers MUST be called direct
   *  from the IDE — the worker proxy refuses local routes (proxy.ts:1111).
   *  Without this flag, a session re-hydrated after a restart would lose
   *  the local-routing decision and try the worker. Optional for backward
   *  compatibility with sessions persisted before this field existed —
   *  agentService re-derives via byokStore lookup when absent. */
  local?: boolean
  /** For custom providers: declared capabilities frozen at snapshot. */
  capabilities?: {
    images: boolean
    audio: boolean
    video: boolean
    tools: boolean
  }
  /** Whether the BYOK model supports a thinking/reasoning toggle. When
   *  true, the request body's thinking parameter is built using
   *  `thinkingShape`, NOT the plan profile shape. Optional for backwards
   *  compatibility with older persisted sessions — when absent, the
   *  agent service falls back to looking up the live byokStore. */
  supportsThinking?: boolean
  /** Shape of the thinking parameter the upstream provider expects.
   *  - `anthropic`: `thinking: { type: 'enabled' | 'disabled', budget_tokens? }`
   *  - `openai_reasoning_effort`: `reasoning_effort: 'minimal' | 'medium'`
   *  - `qwen_enable_thinking`: `enable_thinking: boolean`
   *  - `gemini_thinking_budget`: `thinking_budget: number` (0 = off)
   *  Plan-profile shapes (`enable_thinking` / `reasoning.enabled`) are
   *  silently ignored by Anthropic/OpenAI/Gemini upstreams, which is why
   *  the toggle was a no-op for BYOK before this field existed. */
  thinkingShape?: 'anthropic' | 'openai_reasoning_effort' | 'qwen_enable_thinking' | 'gemini_thinking_budget' | 'openrouter_reasoning' | 'mimo_chat_template_kwargs'
}

export interface SessionContext {
  files: string[]
  fileTreeSummary: string
  projectType: string
  activeFile: string | null
  customInstructions?: string
}

export interface SessionSummary {
  id: string
  name?: string
  projectPath: string
  messageCount: number
  lastMessage: string
  status: ChatSession['status']
  createdAt: number
  updatedAt: number
}

export interface SessionTokenUsage {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTurns: number
}

/** Snapshot of the last on-wire turn's token counters + model identity.
 *  Persisted so the context-window indicator survives a session reload —
 *  without this, every reopen flashes the bar to 0% until the user sends
 *  a new message and the next turn handshake re-populates the live state. */
export interface SessionTurnSnapshot {
  /** Last turn's input tokens — drives the pressure bar. */
  promptTokens: number
  /** Last turn's output tokens — tooltip breakdown only. */
  responseTokens: number
  /** Server-reported model context window (X-Model-Context-Window) at the
   *  last turn. Null when the session was saved before any turn ran. */
  contextWindow: number | null
  /** Friendly model name (X-Model-Name) at the last turn, restored so the
   *  tooltip reads correctly until the next turn handshakes. */
  modelName: string | null
}

export interface PersistedSession {
  id: string
  projectPath: string
  status: ChatSession['status']
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  context?: SessionContext
  tokenUsage?: SessionTokenUsage
  lastTurnSnapshot?: SessionTurnSnapshot
  byokSnapshot?: ByokSessionSnapshot | null
  sessionMemory?: string
  planResumePending?: PlanResumePending | null
}
