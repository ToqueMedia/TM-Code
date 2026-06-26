/**
 * Anthropic ⇄ OpenAI shape adapter for BYOK direct routing.
 *
 * The agent loop (`query.ts`) speaks OpenAI ChatCompletions exclusively. When a
 * BYOK session points at Anthropic (`apiShape: 'anthropic'`), the request goes
 * IDE → SDK → api.anthropic.com DIRECT, but Anthropic's Messages API is shape-
 * incompatible. We translate at the transport boundary (`byokTransport.ts`):
 *
 *   - `toAnthropicRequest`  : OpenAI request body  → Anthropic Messages body
 *   - `anthropicSSEToOpenAISSE` : Anthropic SSE bytes → OpenAI SSE bytes
 *
 * So the loop never knows it isn't talking to an OpenAI-compatible endpoint.
 *
 * Pure functions / standard web streams only (no Tauri / React / store
 * imports) so the translation is unit-testable in isolation.
 */

const ANTHROPIC_VERSION = '2023-06-01'

// ── Request translation ──

interface OpenAIToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIMessage {
  role: string
  content?: unknown
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type AnthropicBlock = Record<string, unknown>
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** Parse an OpenAI multimodal content array into Anthropic content blocks. */
function partsToAnthropicBlocks(parts: unknown): AnthropicBlock[] {
  if (typeof parts === 'string') {
    return parts ? [{ type: 'text', text: parts }] : []
  }
  if (!Array.isArray(parts)) return []
  const blocks: AnthropicBlock[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') {
      blocks.push({ type: 'text', text: p.text })
    } else if (p.type === 'image_url') {
      const url = (p.image_url as Record<string, unknown> | undefined)?.url
      if (typeof url === 'string') {
        const m = /^data:([^;]+);base64,(.*)$/.exec(url)
        if (m) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
        } else {
          // Newer Anthropic accepts a url image source directly.
          blocks.push({ type: 'image', source: { type: 'url', url } })
        }
      }
    }
  }
  return blocks
}

/**
 * Translate an OpenAI ChatCompletion request body into an Anthropic Messages
 * request body. Handles: system extraction, tool_calls → tool_use, tool
 * results → tool_result (folded into user turns), tool defs → input_schema,
 * thinking passthrough, and required max_tokens.
 */
export function toAnthropicRequest(openai: Record<string, unknown>): Record<string, unknown> {
  const srcMessages = Array.isArray(openai.messages) ? (openai.messages as OpenAIMessage[]) : []

  // 1. System: collect all role:'system' messages into the top-level field.
  const systemParts: string[] = []
  for (const m of srcMessages) {
    if (m.role === 'system' && typeof m.content === 'string') systemParts.push(m.content)
  }

  // 2. Build per-message Anthropic turns (tool → user), then coalesce adjacent
  //    same-role turns so the result strictly alternates user/assistant (an
  //    Anthropic requirement; OpenAI emits one `tool` message per result).
  const raw: AnthropicMessage[] = []
  for (const m of srcMessages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) blocks.push({ type: 'text', text })
      else if (Array.isArray(m.content)) blocks.push(...partsToAnthropicBlocks(m.content))
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {}
        try {
          input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: tc.id ?? '', name: tc.function?.name ?? '', input })
      }
      if (blocks.length) raw.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool') {
      // Tool result → a user turn with a tool_result block.
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      raw.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content }],
      })
    } else {
      // user (or any other role) → user turn.
      const blocks = partsToAnthropicBlocks(m.content)
      if (blocks.length) raw.push({ role: 'user', content: blocks })
    }
  }
  const messages: AnthropicMessage[] = []
  for (const turn of raw) {
    const last = messages[messages.length - 1]
    if (last && last.role === turn.role) last.content.push(...turn.content)
    else messages.push({ role: turn.role, content: [...turn.content] })
  }

  // 3. Tools: function defs → Anthropic tool shape.
  const tools = Array.isArray(openai.tools)
    ? (openai.tools as Array<Record<string, unknown>>)
        .map((t): Record<string, unknown> | null => {
          const fn = t.function as Record<string, unknown> | undefined
          if (!fn?.name) return null
          return {
            name: fn.name,
            description: fn.description ?? '',
            input_schema: fn.parameters ?? { type: 'object', properties: {} },
          }
        })
        .filter((x): x is Record<string, unknown> => x !== null)
    : []

  // 4. max_tokens (required). When thinking is enabled, Anthropic requires
  //    max_tokens > thinking.budget_tokens.
  let maxTokens = typeof openai.max_tokens === 'number' ? openai.max_tokens : 4096
  const thinking = openai.thinking as Record<string, unknown> | undefined
  const budget = thinking && typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0
  if (thinking && (thinking as { type?: string }).type === 'enabled' && maxTokens <= budget) {
    maxTokens = budget + 4096
  }

  const out: Record<string, unknown> = {
    model: openai.model,
    max_tokens: maxTokens,
    messages,
    stream: openai.stream === true,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  if (tools.length) out.tools = tools
  if (thinking) out.thinking = thinking
  if (openai.output_config && typeof openai.output_config === 'object') out.output_config = openai.output_config
  return out
}

/** Headers Anthropic requires (auth lives in x-api-key, set by the transport). */
export function anthropicHeaders(): Record<string, string> {
  return { 'anthropic-version': ANTHROPIC_VERSION }
}

/**
 * Translate a NON-streaming Anthropic Messages response (a single JSON object)
 * into an OpenAI ChatCompletion JSON object. Used for one-shot calls (compact /
 * title) under BYOK+Anthropic where the request had `stream:false` and the SDK
 * reads the whole body via `response.json()`.
 */
export function anthropicResponseToOpenAI(resp: Record<string, unknown>): Record<string, unknown> {
  const contentBlocks = Array.isArray(resp.content) ? (resp.content as Array<Record<string, unknown>>) : []
  let text = ''
  const toolCalls: Array<Record<string, unknown>> = []
  let toolIndex = 0
  for (const block of contentBlocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        index: toolIndex++,
        id: block.id ?? '',
        type: 'function',
        function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const usage = resp.usage as Record<string, unknown> | undefined
  const inputTokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens = usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  const message: Record<string, unknown> = { role: 'assistant', content: text }
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: resp.id ?? 'byok-anthropic',
    object: 'chat.completion',
    created: 0,
    model: resp.model ?? 'byok',
    choices: [{ index: 0, message, finish_reason: mapStopReason(resp.stop_reason as string | undefined) ?? 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  }
}

// ── Streaming translation (Anthropic SSE → OpenAI SSE) ──

function mapStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    default:
      return reason ? 'stop' : null
  }
}

/**
 * A TransformStream that rewrites an Anthropic Messages SSE byte stream into an
 * OpenAI ChatCompletions SSE byte stream the OpenAI SDK's parser consumes.
 *
 * Block-index bookkeeping is the delicate part: Anthropic numbers content
 * blocks (text / tool_use / thinking) with its own `index`; OpenAI numbers
 * tool_calls separately. We map each Anthropic tool_use block index → a stable,
 * monotonic OpenAI tool_call index so `input_json_delta` fragments reassemble
 * under the right call (query.ts keys tool calls by `index`).
 */
export function anthropicSSEToOpenAISSE(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let done = false

  // Anthropic block index → OpenAI tool_call index, for tool_use blocks only.
  const toolIndexByBlock = new Map<number, number>()
  let nextToolIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let finishReason: string | null = null

  const created = Math.floor(0) // deterministic; not used by the loop
  const baseChunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
    id: 'byok-anthropic',
    object: 'chat.completion.chunk',
    created,
    model: 'byok',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, obj: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
  }
  const emitDone = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (done) return
    done = true
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
  }

  const handleEvent = (controller: TransformStreamDefaultController<Uint8Array>, dataJson: string) => {
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(dataJson)
    } catch {
      return
    }
    const type = evt.type as string

    if (type === 'message_start') {
      const usage = (evt.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined
      if (usage && typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
      emit(controller, baseChunk({ role: 'assistant' }))
      return
    }

    if (type === 'content_block_start') {
      const index = evt.index as number
      const block = evt.content_block as Record<string, unknown> | undefined
      if (block?.type === 'tool_use') {
        const toolIndex = nextToolIndex++
        toolIndexByBlock.set(index, toolIndex)
        emit(
          controller,
          baseChunk({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id ?? '',
                type: 'function',
                function: { name: block.name ?? '', arguments: '' },
              },
            ],
          }),
        )
      }
      return
    }

    if (type === 'content_block_delta') {
      const index = evt.index as number
      const delta = evt.delta as Record<string, unknown> | undefined
      if (!delta) return
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        emit(controller, baseChunk({ content: delta.text }))
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolIndex = toolIndexByBlock.get(index)
        if (toolIndex !== undefined) {
          emit(controller, baseChunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }))
        }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        // query.ts surfaces reasoning_content on its own channel.
        emit(controller, baseChunk({ reasoning_content: delta.thinking }))
      }
      return
    }

    if (type === 'message_delta') {
      const delta = evt.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.stop_reason === 'string') finishReason = mapStopReason(delta.stop_reason)
      const usage = evt.usage as Record<string, unknown> | undefined
      if (usage && typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
      return
    }

    if (type === 'message_stop') {
      emit(
        controller,
        baseChunk({}, finishReason ?? 'stop', {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        }),
      )
      emitDone(controller)
      return
    }

    if (type === 'error') {
      // Surface as an OpenAI-style error chunk then close. query.ts treats a
      // missing finish as an abrupt end; closing the stream is enough.
      emitDone(controller)
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      // SSE events are separated by a blank line.
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        // Within an event block, collect the data: payload (may be a single
        // line; Anthropic does not split data across lines for these events).
        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('data:')) {
            handleEvent(controller, trimmed.slice(5).trim())
          }
        }
      }
    },
    flush(controller) {
      // Process a trailing event that wasn't terminated by a blank line (the
      // last SSE event may arrive without a final \n\n).
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('data:')) handleEvent(controller, trimmed.slice(5).trim())
        }
        buffer = ''
      }
      emitDone(controller)
    },
  })
}
