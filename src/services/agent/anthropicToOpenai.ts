// Convert an Anthropic-shape request body (what buildRequestBody emits) into
// an OpenAI-compatible body for /v1/chat/completions on local providers
// (Ollama, LM Studio).
//
// Both Ollama (since 0.1.30) and LM Studio expose `/v1/chat/completions` with
// the OpenAI shape, so we target that single shape rather than each
// provider's native endpoint. This keeps the converter simple and the parser
// (parseOpenAISSEStream) provider-agnostic.
//
// Differences handled:
//   - system: Anthropic top-level field → OpenAI first message with role "system"
//   - messages.content: AnthropicContentBlock[] → string OR multimodal array
//     - text blocks         → text
//     - tool_use blocks     → assistant.tool_calls[]
//     - tool_result blocks  → role:"tool" message with tool_call_id
//     - image_url blocks    → multimodal content array (OpenAI shape)
//     - thinking blocks     → dropped (replayed in next turn isn't supported in OpenAI shape)
//   - tools: { name, description, input_schema } → { type:"function", function:{ name, description, parameters } }
//   - thinking param: dropped (OpenAI-shape upstreams ignore it; reasoning
//     models like deepseek-r1 emit reasoning_content automatically)
//
// Things deliberately NOT handled (yet):
//   - Tool choice forcing (`tool_choice` is rare in this codebase)
//   - System message arrays (Anthropic supports system as either string or
//     array of {type:"text",text}; agentService always passes a string)

import type { AnthropicContentBlock } from '../../types/chat'

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIMultimodalContent[] | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type OpenAIMultimodalContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface AnthropicToolDef {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

// Anthropic's system field accepts EITHER a plain string OR an array of
// text blocks (the full schema, used when callers want cache_control on the
// system prompt). agentService currently passes a string, but the converter
// stays robust if a future caller hands us the array shape — collapsing to
// a single string is the closest OpenAI equivalent.
type AnthropicSystem =
  | string
  | Array<{ type: 'text'; text: string; [k: string]: unknown }>

interface AnthropicBody {
  model?: string
  system?: AnthropicSystem
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>
  tools?: AnthropicToolDef[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  // Plan-profile / BYOK thinking params we drop:
  thinking?: unknown
  reasoning_effort?: unknown
  enable_thinking?: unknown
  thinking_budget?: unknown
  [k: string]: unknown
}

function flattenSystem(system: AnthropicSystem | undefined): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map(b => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
}

export function anthropicToOpenAIBody(
  body: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  const a = body as AnthropicBody
  const messages: OpenAIMessage[] = []

  // System message first (OpenAI convention). Skip when empty so we don't
  // burn a slot on a blank message.
  const systemText = flattenSystem(a.system).trim()
  if (systemText.length > 0) {
    messages.push({ role: 'system', content: systemText })
  }

  for (const msg of a.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    const blocks = msg.content
    if (msg.role === 'assistant') {
      // Assistant turn can mix text + tool_use. Collapse text into a single
      // string and surface tool_use as tool_calls. Thinking blocks are dropped
      // — OpenAI shape has no equivalent for replaying past reasoning.
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []
      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
        // tool_result/image_url/thinking not expected in assistant role
      }
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
      }
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      messages.push(assistantMsg)
    } else {
      // User turn: tool_result blocks become separate role:"tool" messages
      // (OpenAI requires one tool message per tool_call_id). Other blocks
      // (text, image) compose into a single user message — multimodal when
      // images are present, plain string otherwise.
      const toolResults: AnthropicContentBlock[] = []
      const userBlocks: AnthropicContentBlock[] = []
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          toolResults.push(block)
        } else {
          userBlocks.push(block)
        }
      }

      // Tool result messages must come BEFORE the next user turn (OpenAI
      // contract: every tool_call gets answered before the next user msg).
      for (const tr of toolResults) {
        if (tr.type !== 'tool_result') continue
        messages.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.tool_use_id,
        })
      }

      if (userBlocks.length > 0) {
        const hasImage = userBlocks.some(b => b.type === 'image_url')
        if (hasImage) {
          const multimodal: OpenAIMultimodalContent[] = []
          for (const b of userBlocks) {
            if (b.type === 'text') multimodal.push({ type: 'text', text: b.text })
            else if (b.type === 'image_url') multimodal.push({ type: 'image_url', image_url: b.image_url })
          }
          messages.push({ role: 'user', content: multimodal })
        } else {
          const text = userBlocks
            .map(b => (b.type === 'text' ? b.text : ''))
            .join('')
          messages.push({ role: 'user', content: text })
        }
      }
    }
  }

  const tools = (a.tools ?? []).map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }))

  const result: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    // Surface usage in the final SSE chunk so the parser can wire token totals.
    stream_options: { include_usage: true },
  }
  if (tools.length > 0) result.tools = tools
  if (typeof a.max_tokens === 'number') result.max_tokens = a.max_tokens
  if (typeof a.temperature === 'number') result.temperature = a.temperature
  if (typeof a.top_p === 'number') result.top_p = a.top_p

  return result
}
