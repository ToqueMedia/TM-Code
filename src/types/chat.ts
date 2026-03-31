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

/** Ordered content block — tracks interleaving of text and tool calls */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string }

/** Message format for OpenAI-compatible conversation history */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  /** Reasoning/thinking content from reasoning models (Step 3.5 Flash, Qwen3, DeepSeek). Preserved across turns so the model can continue reasoning. */
  reasoning_content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
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
}

export interface ChatMessageCard {
  type: 'plan_approval' | 'todo_list'
  projectPath: string
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
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
