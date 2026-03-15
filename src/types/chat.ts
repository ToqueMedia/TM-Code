// === Chat Types ===

/** Message format for OpenAI-compatible conversation history */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
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
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  codeBlocks?: CodeBlock[]
  toolCalls?: ToolCallDisplay[]
  isStreaming?: boolean
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
