import ToolExecutor, { OpenAIToolDefinition } from './toolExecutor'
import FirebaseAuthService from '../auth/firebaseAuth'
import { ServiceError } from '../../utils/errors'
import { parseSSEStream, createThinkingDetector } from './streamParser'
import type { StreamEvent } from './streamParser'

// === Types ===

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// === Config ===

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'

// === Callbacks ===

export interface AgentCallbacks {
  // Streaming text (token by token)
  onTextDelta: (text: string) => void

  // Streaming reasoning (token by token, collapsible in UI)
  onReasoningDelta: (text: string) => void

  // Tool call detected but still accumulating args
  onToolCallPending: (toolId: string, toolName: string) => void

  // Tool call complete, being executed
  onToolCallStart: (toolId: string, toolName: string, args: Record<string, unknown>) => void

  // Tool executed, result available
  onToolResult: (toolId: string, toolName: string, result: string, isError: boolean) => void

  // Turn completed
  onTurnComplete: (turnNumber: number) => void

  // Loop finished
  onDone: (finalText: string) => void

  // Error
  onError: (error: Error) => void

  // Usage
  onUsageUpdate: (inputTokens: number, outputTokens: number) => void
}

// === Turn result ===

interface TurnResult {
  textContent: string
  reasoningContent: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  finishReason: string
  usage: { promptTokens: number; completionTokens: number } | null
}

// === Service ===

class AgentService {
  private static instance: AgentService
  private abortController: AbortController | null = null
  private isRunning = false
  private toolExecutor: ToolExecutor
  private tools: OpenAIToolDefinition[]
  private systemPrompt: string = ''

  private constructor() {
    this.toolExecutor = ToolExecutor.getInstance()
    this.tools = this.toolExecutor.getToolDefinitions()
  }

  static getInstance(): AgentService {
    if (!AgentService.instance) {
      AgentService.instance = new AgentService()
    }
    return AgentService.instance
  }

  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt
  }

  async runAgentLoop(
    userMessage: string,
    conversationHistory: Array<{ role: string; content: string | null; tool_calls?: OpenAIToolCall[]; tool_call_id?: string }>,
    callbacks: AgentCallbacks
  ): Promise<void> {
    if (this.isRunning) {
      this.cancelLoop()
    }
    this.isRunning = true
    this.abortController = new AbortController()

    const messages: OpenAIMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...conversationHistory.map(m => {
        const msg: OpenAIMessage = {
          role: m.role as OpenAIMessage['role'],
          content: m.content
        }
        if (m.tool_calls) msg.tool_calls = m.tool_calls
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
        return msg
      }),
      { role: 'user', content: userMessage }
    ]

    let turnCount = 0

    try {
      while (turnCount < 50) {
        if (this.abortController.signal.aborted) return

        turnCount++

        // Get streaming response
        const response = await this.callAPI(messages)

        // Process the stream
        const turnResult = await this.processStreamedTurn(response, callbacks)

        // Add assistant message to history
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: turnResult.textContent || null,
        }
        if (turnResult.toolCalls.length > 0) {
          assistantMsg.tool_calls = turnResult.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        }
        messages.push(assistantMsg)

        // Report usage
        if (turnResult.usage) {
          callbacks.onUsageUpdate(turnResult.usage.promptTokens, turnResult.usage.completionTokens)
        }

        // If no tool calls, loop is done
        if (
          turnResult.toolCalls.length === 0 ||
          (turnResult.finishReason !== 'tool_calls' && turnResult.finishReason !== 'function_call')
        ) {
          callbacks.onDone(turnResult.textContent || '')
          return
        }

        // Execute tools and add results to history
        for (const toolCall of turnResult.toolCalls) {
          if (this.abortController.signal.aborted) return

          callbacks.onToolCallStart(toolCall.id, toolCall.name, toolCall.args)

          try {
            const result = await this.toolExecutor.execute(toolCall.name, toolCall.args)

            // Sanitize diff JSON: send short summary to LLM, full result to UI
            let llmResult = result
            try {
              const parsed = JSON.parse(result)
              if (parsed.type === 'diff') {
                llmResult = `File ${parsed.isNewFile ? 'created' : 'updated'}: ${parsed.path}`
              }
            } catch {
              // Not JSON, use as-is
            }

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: llmResult,
            })
            callbacks.onToolResult(toolCall.id, toolCall.name, result, false)
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${errorMsg}`,
            })
            callbacks.onToolResult(toolCall.id, toolCall.name, errorMsg, true)
          }
        }

        callbacks.onTurnComplete(turnCount)
      }

      callbacks.onError(new Error(`Agent exceeded maximum turns (50)`))
    } catch (error) {
      if (this.abortController?.signal.aborted) return
      callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.isRunning = false
    }
  }

  cancelLoop(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  private async callAPI(messages: OpenAIMessage[]): Promise<Response> {
    const url = `${WORKER_URL}/v1/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const firebaseToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!firebaseToken) {
      throw new ServiceError(
        'Sessão expirada. Faz login novamente.',
        'AUTH_EXPIRED',
        false
      )
    }
    headers['Authorization'] = `Bearer ${firebaseToken}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          max_tokens: 16384,
          temperature: 0.3,
          messages,
          tools: this.tools,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: this.abortController?.signal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      throw new ServiceError(
        'Sem conexão. Verifica a internet.',
        'NETWORK_ERROR',
        true
      )
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new ServiceError(
          'Sessão expirada. Faz login novamente.',
          'AUTH_EXPIRED',
          false
        )
      }
      if (response.status === 429) {
        throw new ServiceError(
          'Limite de requests atingido. Tenta daqui a pouco.',
          'RATE_LIMIT',
          true
        )
      }
      if (response.status >= 500) {
        throw new ServiceError(
          'Erro no servidor. Tenta novamente.',
          'SERVER_ERROR',
          true
        )
      }

      const errorBody = await response.text()
      throw new ServiceError(
        `Erro na API (${response.status}): ${errorBody}`,
        'API_ERROR',
        false
      )
    }

    if (!response.body) {
      throw new ServiceError('Response body is null', 'API_ERROR', false)
    }

    return response
  }

  private async processStreamedTurn(
    response: Response,
    callbacks: AgentCallbacks
  ): Promise<TurnResult> {
    let textContent = ''
    let reasoningContent = ''
    let finishReason = ''
    let usage: { promptTokens: number; completionTokens: number } | null = null

    // Tool calls accumulator
    const toolCallsMap = new Map<number, {
      id: string
      name: string
      argsStr: string
    }>()

    // Detector for <think> blocks
    const thinkingDetector = createThinkingDetector()

    await parseSSEStream(response, {
      onEvent: (event: StreamEvent) => {
        switch (event.type) {
          case 'text_delta': {
            const { reasoning, content } = thinkingDetector.process(event.content)

            if (reasoning) {
              reasoningContent += reasoning
              callbacks.onReasoningDelta(reasoning)
            }

            if (content) {
              textContent += content
              callbacks.onTextDelta(content)
            }
            break
          }

          case 'reasoning_delta': {
            reasoningContent += event.content
            callbacks.onReasoningDelta(event.content)
            break
          }

          case 'tool_call_start': {
            toolCallsMap.set(event.index, {
              id: event.id,
              name: event.name,
              argsStr: '',
            })
            callbacks.onToolCallPending(event.id, event.name)
            break
          }

          case 'tool_call_args_delta': {
            const tc = toolCallsMap.get(event.index)
            if (tc) {
              tc.argsStr += event.argsDelta
            }
            break
          }

          case 'finish': {
            finishReason = event.reason
            break
          }

          case 'usage': {
            usage = {
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
            }
            break
          }

          case 'error': {
            callbacks.onError(new Error(event.message))
            break
          }

          case 'done': {
            break
          }
        }
      },
    })

    // Parse tool call arguments (now JSON is complete)
    const toolCalls = Array.from(toolCallsMap.values()).map(tc => {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.argsStr)
      } catch {
        args = { _raw: tc.argsStr, _parseError: true }
      }
      return { id: tc.id, name: tc.name, args }
    })

    return {
      textContent,
      reasoningContent,
      toolCalls,
      finishReason,
      usage,
    }
  }
}

export default AgentService
