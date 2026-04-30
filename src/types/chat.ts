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
}

/** Ordered content block — tracks interleaving of text and tool calls
 *  in assistant messages. Used by the chat bubble for inline rendering. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string }

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
 * Anthropic Messages API content block — matches the format used by
 * agentService and chatStore for conversation history.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export interface ConversationMessage {
  role: 'user' | 'assistant'
  /** String for text-only messages, AnthropicContentBlock[] for structured messages
   *  (tool_use blocks, tool_result blocks, thinking blocks, image parts). */
  content: string | AnthropicContentBlock[] | null
}

export interface ToolCallDisplay {
  id: string
  toolName: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'running' | 'completed' | 'failed'
  timestamp: number
  // Diff data (populated for write_file and edit_file)
  diffOldContent?: string
  diffNewContent?: string
  isNewFile?: boolean
  diffStatus?: 'pending' | 'approved' | 'denied'
  diffResultId?: string
  /** Live progress text shown while tool is running (e.g., sub-agent status). */
  progressText?: string
  /** Id of the parent tool call that spawned this one (research / verify / bg agent).
   *  When set, the UI renders this tool call with a nested indent + marker so the
   *  user sees the full sub-agent activity, not just a progress string. */
  spawnedBy?: string
}

export interface CredentialFieldDescriptor {
  id: string
  label: string
  type: 'text' | 'password'
  required: boolean
  helperText?: string
}

export interface ChatMessageCard {
  type: 'plan_approval' | 'todo_list' | 'credential_request'
  projectPath: string
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'submitted' | 'cancelled'
  /** credential_request only: identifies the pending entry in credentialRequestStore */
  requestId?: string
  /** credential_request only: service name (e.g. "OpenAI", "Stripe") shown in the form header */
  serviceName?: string
  /** credential_request only: fields to collect */
  fields?: CredentialFieldDescriptor[]
  /** credential_request only: keys actually submitted (no values) — populated after submit */
  submittedKeys?: string[]
}

export type SystemMessageLevel = 'info' | 'success' | 'error' | 'warn'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  /** For role === 'system': semantic level used for colour-coding in the terminal UI */
  level?: SystemMessageLevel
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
  /** Inline card (plan approval, todo list) */
  card?: ChatMessageCard
  /** Attachments included with this message (metadata only — content is resolved into message.content at send-time) */
  attachments?: Attachment[]
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

export interface PersistedSession {
  id: string
  projectPath: string
  status: ChatSession['status']
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  context?: SessionContext
  tokenUsage?: SessionTokenUsage
}
