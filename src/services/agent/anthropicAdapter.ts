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
 *
 * Prompt caching: Anthropic orders the cached prefix tools → system → messages,
 * so we place breakpoints at all three levels (limit is 4):
 *   1. last tool definition  — the catalog is frozen per run
 *   2. the system prompt     — byte-stable since FASE B (see below)
 *   3. last message block    — incremental history caching, agent loop only
 *
 * FASE B history (2026-07-17 → auditoria 2026-07-28): the contextBuilder used
 * to embed a literal boundary marker separating the stable sections from the
 * per-turn suffix, and this adapter split on it. FASE B moved the split to
 * BUILD time — `buildSystemPrompt` now returns ONLY the static block and the
 * volatile context travels in the user message — so the marker never reaches
 * the transport and `splitOnBoundary` always reported `found: false`. That
 * silently degraded to "no cache_control at all": the whole system prompt and
 * the entire conversation were re-billed at full price on every turn. The
 * no-marker path below is the fix — post-FASE-B the whole system string IS
 * the stable prefix.
 *
 * The real `cache_creation_input_tokens` / `cache_read_input_tokens` reported
 * by Anthropic are propagated through the usage object so query.ts can
 * log hit/miss and the session export can show cached vs non-cached tokens.
 */

import { splitOnBoundary } from './contextBuilder/helpers'

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Anthropic ignores a cache breakpoint whose prefix is under the per-model
 * minimum (1024 tokens on Sonnet/Opus, 2048 on Haiku). 4096 chars ≈ 1.2K
 * tokens: above it caching is worth requesting, below it we keep the plain
 * string shape so one-shot side-calls (compact / title) don't pay the 1.25x
 * cache-WRITE premium for an entry nothing will ever read.
 */
const ANTHROPIC_MIN_CACHEABLE_CHARS = 4096

// ── Request translation ──

/**
 * Build the Anthropic `system` field with a prompt-cache breakpoint on the
 * static prefix.
 *
 * The contextBuilder inserts a literal boundary marker
 * (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) between the cross-session-stable
 * sections (role, tools rules, doing-tasks, constraints …) and the
 * per-session/per-turn sections (memory, git status, file tree …). When the
 * marker is present we emit TWO system blocks and mark the static prefix with
 * `cache_control: { type: 'ephemeral' }` so the ~47K-token stable prefix is
 * cached across turns — the first request creates the cache
 * (cache_creation_input_tokens), subsequent turns read it
 * (cache_read_input_tokens).
 *
 * Without the marker (compact/title one-shots with a plain system string) the
 * system stays a plain string — no cache breakpoint, matching pre-existing
 * behaviour.
 */
function buildCacheableSystem(fullSystem: string): unknown {
  const { staticPrefix, dynamicSuffix, stats } = splitOnBoundary(fullSystem)
  if (!stats.found) {
    // Post-FASE-B: no marker means the caller already did the split and handed
    // us the stable block alone — cache it whole. Short system strings (compact
    // /title one-shots) stay plain: below Anthropic's minimum the breakpoint
    // would be ignored anyway, and the write premium is pure loss.
    if (fullSystem.length < ANTHROPIC_MIN_CACHEABLE_CHARS) return fullSystem
    return [{ type: 'text', text: fullSystem, cache_control: { type: 'ephemeral' } }]
  }
  const blocks: AnthropicBlock[] = []
  if (staticPrefix) {
    blocks.push({ type: 'text', text: staticPrefix, cache_control: { type: 'ephemeral' } })
  }
  if (dynamicSuffix) {
    blocks.push({ type: 'text', text: dynamicSuffix })
  }
  return blocks.length ? blocks : fullSystem
}

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
  /** Blocos de thinking assinados, do round-trip nativo — ver toAnthropicRequest. */
  thinking_blocks?: unknown
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
      // Blocos de thinking assinados PRIMEIRO — a Messages API exige-os no
      // início do turno do assistant e rejeita o pedido se faltarem quando
      // `thinking` está ligado e há tool use. Chegam aqui pelo round-trip
      // nativo (_native é espalhado sobre a mensagem em toOpenAIMessages).
      const thinkingBlocks = m.thinking_blocks
      if (Array.isArray(thinkingBlocks)) {
        for (const tb of thinkingBlocks) {
          if (tb && typeof tb === 'object') blocks.push(tb as AnthropicBlock)
        }
      }
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
  if (systemParts.length) out.system = buildCacheableSystem(systemParts.join('\n\n'))
  if (tools.length) {
    // Tool definitions are stable across turns (the agent doesn't add/remove
    // tools mid-session). Mark the last one with an ephemeral cache breakpoint
    // so the full tool catalog is cached alongside the static system prefix.
    tools[tools.length - 1].cache_control = { type: 'ephemeral' }
    out.tools = tools

    // Incremental history caching: a breakpoint on the LAST block makes the
    // whole conversation so far cacheable, so the next turn (which appends to
    // it) reads the prefix at 0.1x instead of re-billing it. The breakpoint
    // walks forward every turn — that is the intended pattern; Anthropic
    // matches the LONGEST cached prefix.
    //
    // Gated on `tools.length` deliberately: only the agent loop sends tools.
    // One-shot side-calls (compact / title) are single-use, so caching their
    // payload would pay the write premium for an entry nothing re-reads.
    const lastMessage = messages[messages.length - 1]
    const lastBlock = lastMessage?.content[lastMessage.content.length - 1]
    if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' }
  }
  if (thinking) out.thinking = thinking
  if (openai.output_config && typeof openai.output_config === 'object') out.output_config = openai.output_config
  // Sampling passa (auditoria 2026-07-28): as one-shots auxiliares BYOK pedem
  // temperature (byokAuxCompletion) e o adapter deitava-a fora em silêncio —
  // corriam sempre no default do provider. top_p idem. Nunca enviar os dois ao
  // mesmo tempo com thinking ligado: a Messages API rejeita temperature≠1
  // nesse modo, por isso só copiamos quando o thinking está desligado.
  if (!thinking) {
    if (typeof openai.temperature === 'number') out.temperature = openai.temperature
    if (typeof openai.top_p === 'number') out.top_p = openai.top_p
  }
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
  const cacheCreation = usage && typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
  const cacheRead = usage && typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
  const message: Record<string, unknown> = { role: 'assistant', content: text }
  if (toolCalls.length) message.tool_calls = toolCalls
  // Propagate Anthropic prompt-cache usage fields when present so query.ts
  // can log cache hit/miss and the session export shows cached vs non-cached.
  const outUsage: Record<string, number> = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
  if (cacheCreation !== undefined) outUsage.cache_creation_input_tokens = cacheCreation
  if (cacheRead !== undefined) outUsage.cache_read_input_tokens = cacheRead
  return {
    id: resp.id ?? 'byok-anthropic',
    object: 'chat.completion',
    created: 0,
    model: resp.model ?? 'byok',
    choices: [{ index: 0, message, finish_reason: mapStopReason(resp.stop_reason as string | undefined) ?? 'stop' }],
    usage: outUsage,
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
  // Anthropic prompt-cache usage — captured from message_start and surfaced
  // on the final chunk so query.ts can log cache hit/miss per request.
  let cacheCreationInputTokens: number | undefined
  let cacheReadInputTokens: number | undefined
  let finishReason: string | null = null

  // ── Thinking blocks + assinaturas (auditoria 2026-07-28) ──
  // Com `thinking: enabled` E tool use, a Messages API EXIGE que os blocos de
  // thinking assinados voltem no turno do assistant. O adapter mapeava
  // thinking_delta → reasoning_content e deitava fora o signature_delta, e o
  // toAnthropicRequest reconstruía o turno só a partir de texto + tool_calls —
  // portanto todo o loop de tools em BYOK-Anthropic com thinking ligado era
  // rejeitado pelo provider.
  //
  // Cada bloco é acumulado aqui e a LISTA COMPLETA é emitida no
  // content_block_stop. Emitir a lista inteira (e não o bloco novo) é
  // deliberado: o acumulador de campos extra do query.ts faz overwrite por
  // chave, não append — a última emissão tem de ser auto-suficiente.
  const thinkingByBlock = new Map<number, { type: string; thinking: string; signature?: string; data?: string }>()
  const completedThinkingBlocks: Array<Record<string, unknown>> = []

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
      if (usage && typeof usage.cache_creation_input_tokens === 'number') cacheCreationInputTokens = usage.cache_creation_input_tokens
      if (usage && typeof usage.cache_read_input_tokens === 'number') cacheReadInputTokens = usage.cache_read_input_tokens
      emit(controller, baseChunk({ role: 'assistant' }))
      return
    }

    if (type === 'content_block_start') {
      const index = evt.index as number
      const block = evt.content_block as Record<string, unknown> | undefined
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        thinkingByBlock.set(index, {
          type: block.type as string,
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : undefined,
          data: typeof block.data === 'string' ? block.data : undefined,
        })
        return
      }
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
        const acc = thinkingByBlock.get(index)
        if (acc) acc.thinking += delta.thinking
        emit(controller, baseChunk({ reasoning_content: delta.thinking }))
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        // A assinatura NÃO é texto para o utilizador — é o que prova ao
        // provider que o bloco de raciocínio é autêntico quando volta.
        const acc = thinkingByBlock.get(index)
        if (acc) acc.signature = (acc.signature ?? '') + delta.signature
      }
      return
    }

    if (type === 'content_block_stop') {
      const index = evt.index as number
      const acc = thinkingByBlock.get(index)
      if (acc) {
        thinkingByBlock.delete(index)
        completedThinkingBlocks.push(
          acc.type === 'redacted_thinking'
            ? { type: 'redacted_thinking', data: acc.data ?? '' }
            : { type: 'thinking', thinking: acc.thinking, signature: acc.signature ?? '' },
        )
        // Lista COMPLETA de cada vez — ver a nota no acumulador acima.
        emit(controller, baseChunk({ thinking_blocks: [...completedThinkingBlocks] }))
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
      // Build the final usage chunk, propagating Anthropic prompt-cache
      // fields when the provider reported them so query.ts can distinguish
      // cache reads (hit) from cache creates (miss → write).
      const finalUsage: Record<string, number> = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      }
      if (cacheCreationInputTokens !== undefined) finalUsage.cache_creation_input_tokens = cacheCreationInputTokens
      if (cacheReadInputTokens !== undefined) finalUsage.cache_read_input_tokens = cacheReadInputTokens
      emit(
        controller,
        baseChunk({}, finishReason ?? 'stop', { usage: finalUsage }),
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
