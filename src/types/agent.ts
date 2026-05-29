// === Agent Types ===

// Status semantics:
//   awaiting_response — prompt sent, waiting for first upstream token (TTFT) or
//                       waiting for the model's next turn after a tool result.
//   reasoning         — reasoning_delta is actively streaming (model emitting
//                       chain-of-thought into a thinking block / <think> tag).
//   generating        — visible text deltas streaming to the user.
//   applying          — a tool call is dispatched / executing.
//   compressing       — context compression is in flight.
export type AgentStatus =
  | 'idle'
  | 'awaiting_response'
  | 'reasoning'
  | 'generating'
  | 'applying'
  | 'compressing'
  | 'error'

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type AgentToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'create_file'
  | 'create_directory'
  | 'delete_file'
  | 'rename_file'
  | 'list_directory'
  | 'search_files'
  | 'glob'
  | 'execute_command'
  | 'start_dev_server'
  | 'web_fetch'

export interface AgentToolCall {
  id: string
  tool: AgentToolName
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: unknown
  error?: string
}

export interface AgentResponse {
  type: 'text' | 'code' | 'tool_call' | 'error' | 'done'
  content?: string
  language?: string
  filePath?: string
  toolCall?: AgentToolCall
}

// === Context Compression ===

export type CompactTrigger = 'auto' | 'manual' | 'reactive'

export type CompactPhase = 'idle' | 'hooks_pre' | 'compressing' | 'hooks_post' | 'done'

export type CompactProgressEvent =
  | { type: 'hooks_start'; hookType: 'pre_compact' | 'post_compact' | 'session_start' }
  | { type: 'compact_start'; beforeTokens: number; trigger: CompactTrigger }
  | { type: 'compact_end'; beforeTokens: number; trigger: CompactTrigger; messagesSummarized?: number }
