import ToolExecutor, { OpenAIToolDefinition } from './toolExecutor'
import FirebaseAuthService from '../auth/firebaseAuth'
import { ServiceError } from '../../utils/errors'

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

interface OpenAIResponse {
  id: string
  choices: Array<{
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'function_call'
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens?: number
  }
}

// === Config ===

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'

// === Callbacks ===

export interface AgentCallbacks {
  onTextChunk: (text: string) => void
  onToolCall: (toolName: string, input: Record<string, unknown>) => void
  onToolResult: (toolName: string, result: string, isError: boolean) => void
  onTurnComplete: (turnNumber: number) => void
  onDone: (finalText: string) => void
  onError: (error: Error) => void
  onUsageUpdate: (inputTokens: number, outputTokens: number) => void
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
    // Cancel any existing loop before starting a new one
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

        // Stream the response token by token
        const response = await this.callAPIStreaming(messages, callbacks)
        const choice = response.choices[0]
        const message = choice.message

        // Text content was already streamed via onTextChunk in parseSSEStream

        // Notify tool calls (with fully parsed arguments)
        const toolCalls = message.tool_calls || []
        for (const tc of toolCalls) {
          try {
            const args = JSON.parse(tc.function.arguments)
            callbacks.onToolCall(tc.function.name, args)
          } catch {
            callbacks.onToolCall(tc.function.name, {})
          }
        }

        // Report token usage
        if (response.usage.prompt_tokens || response.usage.completion_tokens) {
          callbacks.onUsageUpdate(
            response.usage.prompt_tokens,
            response.usage.completion_tokens
          )
        }

        // Add assistant message to history
        const assistantMsg: OpenAIMessage = { role: 'assistant' }
        assistantMsg.content = message.content ?? null
        if (message.tool_calls) {
          assistantMsg.tool_calls = message.tool_calls
        }
        messages.push(assistantMsg)

        // If no tool calls, loop is done
        if (
          toolCalls.length === 0 ||
          (choice.finish_reason !== 'tool_calls' && choice.finish_reason !== 'function_call')
        ) {
          callbacks.onDone(message.content || '')
          return
        }

        // Execute each tool locally
        for (const toolCall of toolCalls) {
          if (this.abortController.signal.aborted) return

          let args: Record<string, unknown>
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = {}
          }

          try {
            const result = await this.toolExecutor.execute(toolCall.function.name, args)
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            })
            callbacks.onToolResult(toolCall.function.name, result, false)
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${errorMsg}`
            })
            callbacks.onToolResult(toolCall.function.name, errorMsg, true)
          }
        }

        callbacks.onTurnComplete(turnCount)
      }

      // Safety: maxTurns reached
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

  private async callAPIStreaming(
    messages: OpenAIMessage[],
    callbacks: AgentCallbacks
  ): Promise<OpenAIResponse> {
    const url = `${WORKER_URL}/v1/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    // Always authenticate with Firebase token
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
          // No "model" field — Worker decides
          max_tokens: 8192,
          temperature: 0.3,
          messages,
          tools: this.tools,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: this.abortController?.signal
      })
    } catch (err) {
      // Network-level failure (no internet, DNS, CORS, etc.)
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err // Let abort propagation continue as-is
      }
      throw new ServiceError(
        'Sem conexão. Verifica a internet.',
        'NETWORK_ERROR',
        true
      )
    }

    if (!response.ok) {
      // Handle specific HTTP status codes with user-friendly messages
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

    return this.parseSSEStream(response, callbacks)
  }

  private async parseSSEStream(
    response: Response,
    callbacks: AgentCallbacks
  ): Promise<OpenAIResponse> {
    if (!response.body) {
      throw new ServiceError('Response body is null', 'API_ERROR', false)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    let accumulatedContent = ''
    const accumulatedToolCalls: OpenAIToolCall[] = []
    const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map()
    let finishReason: string = 'stop'
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let responseId = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (this.abortController?.signal.aborted) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE lines
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed === 'data: [DONE]') continue

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6)
          try {
            const chunk = JSON.parse(jsonStr)
            responseId = chunk.id || responseId

            if (chunk.usage) {
              usage = {
                prompt_tokens: chunk.usage.prompt_tokens || usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens || usage.completion_tokens
              }
            }

            const delta = chunk.choices?.[0]?.delta
            const chunkFinish = chunk.choices?.[0]?.finish_reason

            if (chunkFinish) {
              finishReason = chunkFinish
            }

            if (delta) {
              // Text content delta — stream to UI immediately
              if (delta.content) {
                accumulatedContent += delta.content
                callbacks.onTextChunk(delta.content)
              }

              // Tool call deltas
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0
                  if (tc.id) {
                    // New tool call starting
                    toolCallBuffers.set(idx, {
                      id: tc.id,
                      name: tc.function?.name || '',
                      args: tc.function?.arguments || ''
                    })
                  } else if (toolCallBuffers.has(idx)) {
                    // Continuation — append argument fragments
                    const existing = toolCallBuffers.get(idx)!
                    if (tc.function?.name) existing.name += tc.function.name
                    if (tc.function?.arguments) existing.args += tc.function.arguments
                  }
                }
              }
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      }
    }

    // Finalize tool calls from buffers
    for (const [, buf] of toolCallBuffers) {
      accumulatedToolCalls.push({
        id: buf.id,
        type: 'function',
        function: { name: buf.name, arguments: buf.args }
      })
    }

    return {
      id: responseId,
      choices: [{
        message: {
          role: 'assistant',
          content: accumulatedContent || null,
          tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined
        },
        finish_reason: finishReason as OpenAIResponse['choices'][0]['finish_reason']
      }],
      usage
    }
  }
}

export default AgentService
