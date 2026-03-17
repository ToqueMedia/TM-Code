// === Agent Types ===

export type AgentStatus = 'idle' | 'thinking' | 'generating' | 'applying' | 'compressing' | 'error'

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
  | 'get_diagnostics'
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
