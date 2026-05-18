// SSE Stream Parser for Anthropic Messages API streaming responses
//
// Anthropic SSE uses event: + data: lines (unlike OpenAI which is just data:):
//
//   event: message_start
//   data: {"type":"message_start","message":{"id":"msg_1",...}}
//
//   event: content_block_start
//   data: {"type":"content_block_start","index":0,"content_block":{"type":"text",...}}
//
//   event: content_block_delta
//   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
//
//   event: content_block_stop
//   data: {"type":"content_block_stop","index":0}
//
//   event: message_delta
//   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}
//
//   event: message_stop
//   data: {"type":"message_stop"}
//
// The billing event is a TM Code extension passed through as bare `data:` line
// (no event: prefix) — handled inline.

import type { CostBudgetStatus, UserPlanName } from '../../stores/billingStore'
import { logger } from '../../utils/logger'

export type StreamEvent =
  // Content events
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  // Tool events — Phase D uses content_block_stop as authoritative dispatch signal
  | { type: 'content_block_start'; index: number; blockType: 'text' | 'tool_use' | 'thinking'; toolId?: string; toolName?: string }
  | { type: 'tool_input_delta'; index: number; partialJson: string }
  | { type: 'content_block_stop'; index: number }
  // Message lifecycle
  | { type: 'message_start'; messageId: string; inputTokens: number }
  | { type: 'message_delta'; stopReason: string; outputTokens: number }
  | { type: 'message_stop' }
  // Usage (emitted from message_start and message_delta)
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  // Billing (TM Code extension — bare data: line from billingStream)
  | {
      type: 'billing'
      consumedPct: number
      status: CostBudgetStatus
      tokensUsed: number
      tokensConsumed: number
      tokenBudget: number
      cycleEnd: string
      tmsRemaining: number
      plan: UserPlanName
      usedOverage: boolean
    }
  | { type: 'error'; message: string; errorType?: string }
  | { type: 'done' }

interface StreamParserCallbacks {
  onEvent: (event: StreamEvent) => void
}

/**
 * Parse an Anthropic SSE stream from the worker's /v1/messages endpoint.
 *
 * Handles both event:+data: Anthropic events AND bare data: billing events
 * (TM Code extension injected by billingStream before the converter).
 */
/**
 * Streaming-idle watchdog: if the upstream emits no bytes for this long,
 * treat the stream as silently broken and surface it as `upstream_stream_interrupted`
 * so the agent loop's retry path kicks in (`agentService.ts:789-823`).
 *
 * Without this, a stalled upstream (DashScope / OpenRouter / direct-BYOK)
 * holds the IDE in `await reader.read()` indefinitely because the SDK's
 * request timeout only covers the initial fetch, not the streamed body.
 *
 * Claude-vaz parity: `services/api/claude.ts:1868-1928` uses the same
 * 90 s value (`STREAM_IDLE_TIMEOUT_MS`) with a half-time warning. We skip
 * the warning here — the retry path is the visible UX, no separate
 * "warning" state to surface.
 *
 * The worker already sends SSE heartbeats (`fix(proxy): heartbeated SSE
 * response`), so a healthy upstream resets the timer at least once every
 * heartbeat interval. The watchdog only fires when both the upstream AND
 * the heartbeat have gone silent — i.e. genuine stall.
 *
 * Build-time override via Vite env: `VITE_STREAM_IDLE_TIMEOUT_MS=180000`.
 * Useful for local BYOK with heavy models (70B+ on consumer hardware can
 * legitimately take >90s for the first token). Minimum 10 s floor so a
 * misconfigured value doesn't disable the watchdog entirely.
 */
function getStreamIdleTimeoutMs(): number {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
    const raw = meta.env?.VITE_STREAM_IDLE_TIMEOUT_MS
    if (raw) {
      const v = parseInt(raw, 10)
      if (Number.isFinite(v) && v >= 10_000) return v
    }
  } catch {
    /* import.meta not available (e.g. Jest) — fall back to default */
  }
  return 90_000
}
const STREAM_IDLE_TIMEOUT_MS = getStreamIdleTimeoutMs()

/**
 * Race one read() against an idle-timeout. Promise.race is the defensive
 * pattern over `reader.cancel()`-from-a-timer: if the underlying cancel
 * doesn't unblock the pending read (which can happen on some streams), we
 * still resolve via the timer branch and exit the parser loop. The pending
 * read promise leaks briefly but the stream is cancelled and the loop
 * exits cleanly. Single source of truth for both parsers below.
 */
type ReadOrTimeout =
  | { kind: 'chunk'; done: boolean; value?: Uint8Array }
  | { kind: 'timeout' }
  | { kind: 'error'; error: Error }

async function readChunkOrTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadOrTimeout> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<ReadOrTimeout>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  // WebKit (Tauri webview) rejects reader.read() with `TypeError: Load failed`
  // when the underlying connection drops mid-stream — typical when the user
  // switches Wi-Fi networks. Without this catch the rejection bubbles past
  // parseSSEStream's try/finally (no catch) and hits the agent loop's outer
  // catch as a plain Error → `ServiceError('Load failed', 'UNKNOWN_ERROR',
  // false)`, which is non-retryable AND surfaces the raw browser message to
  // the user. Catching here lets us route the failure through the same
  // upstream_stream_interrupted typed event the watchdog uses, which already
  // has an auto-retry path + friendly ephemeral message.
  const readPromise = reader.read().then(
    r => ({ kind: 'chunk' as const, done: r.done, value: r.value }),
    err => ({ kind: 'error' as const, error: err instanceof Error ? err : new Error(String(err)) }),
  )
  try {
    return await Promise.race([readPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function parseSSEStream(
  response: Response,
  callbacks: StreamParserCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) return

      const r = await readChunkOrTimeout(reader, STREAM_IDLE_TIMEOUT_MS)
      if (r.kind === 'timeout') {
        logger.warn('agent', `[stream-watchdog] anthropic SSE — no upstream bytes for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, emitting upstream_stream_interrupted`)
        callbacks.onEvent({
          type: 'error',
          message: `Stream idle timeout — no bytes from upstream for ${STREAM_IDLE_TIMEOUT_MS / 1000}s. Treating as interrupted; the agent loop will retry.`,
          errorType: 'upstream_stream_interrupted',
        })
        reader.cancel().catch(() => { /* best-effort, the read may stay pending */ })
        return
      }
      if (r.kind === 'error') {
        logger.warn('agent', `[stream] anthropic SSE — reader.read() rejected mid-stream: ${r.error.message}`)
        callbacks.onEvent({
          type: 'error',
          message: `Connection dropped mid-stream (${r.error.message}). Treating as interrupted; the agent loop will retry.`,
          errorType: 'upstream_stream_interrupted',
        })
        reader.cancel().catch(() => { /* best-effort */ })
        return
      }
      if (r.done) break
      if (!r.value) continue

      buffer += decoder.decode(r.value, { stream: true })

      const lastNewline = buffer.lastIndexOf('\n')
      if (lastNewline === -1) continue

      const complete = buffer.slice(0, lastNewline)
      buffer = buffer.slice(lastNewline + 1)

      const lines = complete.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue

        // Anthropic event type line
        if (trimmed.startsWith('event: ')) {
          // event: line — we don't need to track it because the
          // Anthropic converter embeds the type in the data JSON payload
          continue
        }

        // Data line
        if (trimmed.startsWith('data: ')) {
          const rawData = trimmed.slice(6)

          let json: any
          try {
            json = JSON.parse(rawData)
          } catch {
            continue // malformed JSON — skip
          }

          // TM Code billing extension (bare data: line, no event: prefix)
          if (json.type === 'billing') {
            callbacks.onEvent({
              type: 'billing',
              consumedPct: typeof json.consumed_pct === 'number' ? json.consumed_pct : 0,
              status: (json.status ?? 'allowed') as CostBudgetStatus,
              tokensUsed: json.tokens_used ?? 0,
              tokensConsumed: json.tokens_consumed ?? 0,
              tokenBudget: json.token_budget ?? 0,
              cycleEnd: json.cycle_end ?? '',
              tmsRemaining: json.extra_usage_balance ?? 0,
              plan: (json.plan ?? 'explorer') as UserPlanName,
              usedOverage: Boolean(json.used_overage),
            })
            // (event type is in data.type)
            continue
          }

          // Process Anthropic event based on the type field in the data
          processAnthropicEvent(json, callbacks)
        }
      }
    }

    // Flush remaining
    if (buffer.trim()) {
      const lines = buffer.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6))
            if (json.type === 'billing') continue
            processAnthropicEvent(json, callbacks)
          } catch { /* ignore */ }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function processAnthropicEvent(
  data: any,
  callbacks: StreamParserCallbacks,
): void {
  switch (data.type) {
    case 'message_start': {
      const msg = data.message
      // Context window holds NEW input + cached reads + cache writes. The
      // Anthropic usage block splits them across three fields because
      // billing differs (cache reads cost less). Pressure-wise they all
      // occupy slots, so sum them for the pill / compression heuristic.
      // Upstreams that don't support caching just drop the cache fields
      // → defaults to 0, behaviour unchanged.
      const u = msg?.usage ?? {}
      const inputTokens =
        (u.input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0)
      callbacks.onEvent({
        type: 'message_start',
        messageId: msg?.id ?? '',
        inputTokens,
      })
      callbacks.onEvent({
        type: 'usage',
        promptTokens: inputTokens,
        completionTokens: 0,
      })
      break
    }

    case 'content_block_start': {
      const block = data.content_block
      const index = data.index ?? 0
      if (block?.type === 'tool_use') {
        callbacks.onEvent({
          type: 'content_block_start',
          index,
          blockType: 'tool_use',
          toolId: block.id,
          toolName: block.name,
        })
      } else if (block?.type === 'thinking') {
        callbacks.onEvent({
          type: 'content_block_start',
          index,
          blockType: 'thinking',
        })
      } else {
        // text block (or unknown type — treat as text)
        callbacks.onEvent({
          type: 'content_block_start',
          index,
          blockType: 'text',
        })
      }
      break
    }

    case 'content_block_delta': {
      const delta = data.delta
      const index = data.index ?? 0
      if (delta?.type === 'text_delta') {
        callbacks.onEvent({ type: 'text_delta', content: delta.text ?? '' })
      } else if (delta?.type === 'thinking_delta') {
        callbacks.onEvent({ type: 'reasoning_delta', content: delta.thinking ?? '' })
      } else if (delta?.type === 'input_json_delta') {
        callbacks.onEvent({
          type: 'tool_input_delta',
          index,
          partialJson: delta.partial_json ?? '',
        })
      }
      break
    }

    case 'content_block_stop': {
      // Phase D: this is the authoritative signal that a tool's arguments
      // are complete. The frontend dispatches the tool to the pool on this
      // event — no heuristic sealing, no false positives.
      callbacks.onEvent({
        type: 'content_block_stop',
        index: data.index ?? 0,
      })
      break
    }

    case 'message_delta': {
      const stopReason = data.delta?.stop_reason ?? 'end_turn'
      const u = data.usage ?? {}
      // Output_tokens already includes thinking/reasoning tokens on the
      // Anthropic native API (the spec counts thinking as output). For
      // OpenAI-shape adapters, `completion_tokens_details.reasoning_tokens`
      // may be reported separately — fold it in defensively so the pill's
      // pressure reflects what actually occupies the window.
      const outputTokens =
        (u.output_tokens ?? 0)
        + (u.reasoning_tokens ?? 0)
      // Anthropic native streams only carry output_tokens here, but the
      // worker's OpenAI→Anthropic adapter (used for BYOK on openai_compat
      // upstreams) re-emits input_tokens on message_delta because OpenAI-
      // shape providers report usage AFTER finish_reason — too late for
      // message_start's usage block. Reading it here lets the IDE pick
      // up the real prompt-token count on BYOK routes so compression
      // triggers and the context-window indicator updates. Cache splits
      // are summed for the same window-pressure reason as in message_start.
      const inputTokens =
        (u.input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0)
      callbacks.onEvent({
        type: 'message_delta',
        stopReason,
        outputTokens,
      })
      callbacks.onEvent({
        type: 'usage',
        promptTokens: inputTokens,
        completionTokens: outputTokens,
      })
      break
    }

    case 'message_stop': {
      callbacks.onEvent({ type: 'done' })
      break
    }

    case 'error': {
      // Anthropic-shape error event from the worker's adapter conversion of
      // our typed upstream error envelopes (proxy.ts → anthropicAdapter.ts).
      // Pass the typed `error.type` through as `errorType` so the agent's
      // processStreamedTurn maps `upstream_stream_interrupted` to the
      // auto-retry path instead of treating it as a hard error.
      const errObj = data.error
      const errType = typeof errObj?.type === 'string' ? errObj.type : undefined
      let msg: string
      if (errType === 'upstream_stream_interrupted') {
        msg = `The model's response was interrupted mid-stream (upstream: ${errObj?.provider || 'unknown'}). ` +
              `This is usually a transient network issue — retrying.`
      } else if (errType === 'upstream_fetch_failed') {
        msg = `Could not reach the model after multiple retries: ${errObj?.message || 'unknown error'}`
      } else if (errType === 'upstream_http_error') {
        msg = `Upstream returned HTTP ${errObj?.status || '?'}: ${errObj?.message || ''}`
      } else {
        msg = errObj?.message ?? JSON.stringify(data)
      }
      callbacks.onEvent({
        type: 'error',
        message: msg,
        errorType: errType,
      })
      break
    }
  }
}

// ── OpenAI-compatible SSE parser (for local BYOK: Ollama, LM Studio) ─────
//
// Both Ollama (since 0.1.30) and LM Studio expose `/v1/chat/completions` in
// OpenAI shape, so we have a single parser regardless of provider. The
// upstream SSE format differs from Anthropic in three ways:
//
//   1. Bare `data:` lines, no `event:` prefix.
//   2. Final stream marker: `data: [DONE]` (literal string), not a
//      `message_stop` event.
//   3. Content lives at `choices[0].delta.{content, role, tool_calls,
//      reasoning_content, finish_reason}`. No "block index" — text and
//      tool calls share a single virtual stream and we have to derive the
//      block boundaries ourselves.
//
// We translate to the same StreamEvent shape parseSSEStream emits so the
// downstream consumer (processStreamedTurn) doesn't need a parallel branch.
// Block boundaries: index 0 = text, index 1 = first tool, index 2 = second…
//
// Tools come in as deltas: the FIRST delta with a tool_call carries the id
// and name, subsequent deltas carry argument fragments. We open the block
// on the first delta and emit content_block_stop when the next tool starts
// or when finish_reason fires.
//
// Reasoning: OpenAI-shape upstreams that support thinking (DeepSeek-R1,
// some Qwen3 variants) emit `delta.reasoning_content` separately from
// `delta.content`. Translated to reasoning_delta — same downstream path
// as Anthropic's thinking_delta.

interface OpenAIDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: 'function'
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface OpenAIChoice {
  index?: number
  delta?: OpenAIDelta
  finish_reason?: string | null
}

interface OpenAIChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: OpenAIChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  /**
   * Synthetic error envelope emitted by our worker when the upstream stream
   * drops mid-flight (see proxy.ts `wrapStreamWithErrorCapture`). Not part of
   * OpenAI's published SSE shape, but compatible with the OpenAI SDK's
   * stream-error contract (the SDK reads root-level `error` on any chunk).
   * Surfacing it as a typed parser event lets the agent retry sensibly
   * instead of treating the truncated stream as a successful `end_turn`.
   */
  error?: {
    type?: string
    message?: string
    provider?: string
    model?: string
  }
}

export async function parseOpenAISSEStream(
  response: Response,
  callbacks: StreamParserCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Block-tracking state. blockOpen[0] is the text block; tool blocks are
  // numbered from 1 by the order they appear in tool_calls deltas. We map
  // the upstream's "tool_calls[i].index" (Ollama/LM Studio both emit it)
  // to our internal block index so multiple parallel tool calls are
  // separable downstream.
  let textOpen = false
  let textEmitted = false
  // Map upstream tool index → our block index. Used so subsequent argument
  // deltas land on the right block.
  const toolBlockByUpstreamIdx = new Map<number, number>()
  let nextBlockIndex = 1
  let messageStarted = false
  let promptTokens = 0
  let messageStopEmitted = false

  const closeOpenTextBlock = () => {
    if (textOpen) {
      callbacks.onEvent({ type: 'content_block_stop', index: 0 })
      textOpen = false
    }
  }

  const closeAllToolBlocks = () => {
    for (const blockIdx of toolBlockByUpstreamIdx.values()) {
      callbacks.onEvent({ type: 'content_block_stop', index: blockIdx })
    }
    toolBlockByUpstreamIdx.clear()
  }

  const ensureMessageStart = () => {
    if (messageStarted) return
    messageStarted = true
    callbacks.onEvent({
      type: 'message_start',
      messageId: '',
      inputTokens: 0,
    })
  }

  const processChunk = (chunk: OpenAIChunk) => {
    // Mid-stream upstream interruption captured by the worker's
    // wrapStreamWithErrorCapture (proxy.ts). The worker keeps `outcome: "ok"`
    // and emits this chunk + `data: [DONE]` so the parser closes cleanly
    // and the agent sees a typed error event instead of pretending the
    // truncated stream was a clean end_turn (which would surface as the
    // agent silently freezing — see BugHunter sess_1778939230235_o3x3ar
    // for the symptom this fix addresses).
    if (chunk.error && typeof chunk.error.message === 'string') {
      closeOpenTextBlock()
      closeAllToolBlocks()
      const errType = chunk.error.type || 'upstream_error'
      const msg = errType === 'upstream_stream_interrupted'
        ? `The model's response was interrupted mid-stream (upstream: ${chunk.error.provider || 'unknown'}). ` +
          `This is usually a transient network issue — retrying.`
        : `Upstream error (${errType}): ${chunk.error.message}`
      callbacks.onEvent({ type: 'error', message: msg, errorType: errType })
      // Don't emit `done` — the agent's onError handler is the right
      // termination path; emitting both would race.
      messageStopEmitted = true
      return
    }
    // Some Ollama builds send a final-only object with usage and no choices
    // — treat as usage-only update.
    if (chunk.usage) {
      // OpenAI shape: prompt_tokens is the new-input count; cached portion
      // is reported separately under `prompt_tokens_details.cached_tokens`
      // (when the provider supports caching). For window pressure we need
      // the SUM — cached tokens still occupy slots. Same logic for
      // reasoning tokens on the completion side.
      const usage = chunk.usage as {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        completion_tokens_details?: { reasoning_tokens?: number }
      }
      const cachedInput = usage.prompt_tokens_details?.cached_tokens ?? 0
      const reasoningOut = usage.completion_tokens_details?.reasoning_tokens ?? 0
      const prompt = (usage.prompt_tokens ?? 0) + cachedInput
      const completion = (usage.completion_tokens ?? 0) + reasoningOut
      if (prompt > 0) promptTokens = prompt
      callbacks.onEvent({
        type: 'usage',
        promptTokens: promptTokens || prompt,
        completionTokens: completion,
      })
    }

    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? {}

    ensureMessageStart()

    // Reasoning content (DeepSeek-R1 / some Qwen3): emit before opening the
    // text block. processStreamedTurn handles reasoning deltas independently.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      callbacks.onEvent({
        type: 'reasoning_delta',
        content: delta.reasoning_content,
      })
    }

    // Tool calls — close text first so the block ordering is sane downstream.
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      closeOpenTextBlock()
      for (const tc of delta.tool_calls) {
        const upstreamIdx = tc.index ?? 0
        let blockIdx = toolBlockByUpstreamIdx.get(upstreamIdx)
        if (blockIdx === undefined) {
          blockIdx = nextBlockIndex++
          toolBlockByUpstreamIdx.set(upstreamIdx, blockIdx)
          callbacks.onEvent({
            type: 'content_block_start',
            index: blockIdx,
            blockType: 'tool_use',
            toolId: tc.id ?? `call_${blockIdx}`,
            toolName: tc.function?.name ?? '',
          })
        }
        const fragment = tc.function?.arguments ?? ''
        if (fragment.length > 0) {
          callbacks.onEvent({
            type: 'tool_input_delta',
            index: blockIdx,
            partialJson: fragment,
          })
        }
      }
    }

    // Plain text content.
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!textOpen) {
        callbacks.onEvent({
          type: 'content_block_start',
          index: 0,
          blockType: 'text',
        })
        textOpen = true
      }
      textEmitted = true
      callbacks.onEvent({ type: 'text_delta', content: delta.content })
    }

    if (choice.finish_reason) {
      closeOpenTextBlock()
      closeAllToolBlocks()
      // Map finish_reason to Anthropic-shape stop_reason for downstream
      // compatibility. tool_calls → tool_use; stop/length → end_turn/max_tokens.
      const stopReason =
        choice.finish_reason === 'tool_calls' ? 'tool_use'
        : choice.finish_reason === 'length' ? 'max_tokens'
        : 'end_turn'
      callbacks.onEvent({
        type: 'message_delta',
        stopReason,
        outputTokens: chunk.usage?.completion_tokens ?? 0,
      })
      if (!messageStopEmitted) {
        messageStopEmitted = true
        callbacks.onEvent({ type: 'done' })
      }
    }
  }

  // Same streaming-idle watchdog as parseSSEStream — local BYOK (Ollama,
  // LM Studio) is at least as susceptible: a hung local model server has
  // no heartbeat at all. Promise.race shape so cancel() not unblocking
  // doesn't trap us.
  try {
    while (true) {
      if (signal?.aborted) return
      const r = await readChunkOrTimeout(reader, STREAM_IDLE_TIMEOUT_MS)
      if (r.kind === 'timeout') {
        logger.warn('agent', `[stream-watchdog] openai SSE — no upstream bytes for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, emitting upstream_stream_interrupted`)
        callbacks.onEvent({
          type: 'error',
          message: `Stream idle timeout — no bytes from upstream for ${STREAM_IDLE_TIMEOUT_MS / 1000}s. Treating as interrupted; the agent loop will retry.`,
          errorType: 'upstream_stream_interrupted',
        })
        reader.cancel().catch(() => { /* best-effort */ })
        return
      }
      if (r.kind === 'error') {
        logger.warn('agent', `[stream] openai SSE — reader.read() rejected mid-stream: ${r.error.message}`)
        callbacks.onEvent({
          type: 'error',
          message: `Connection dropped mid-stream (${r.error.message}). Treating as interrupted; the agent loop will retry.`,
          errorType: 'upstream_stream_interrupted',
        })
        reader.cancel().catch(() => { /* best-effort */ })
        return
      }
      if (r.done) break
      if (!r.value) continue
      buffer += decoder.decode(r.value, { stream: true })

      const lastNewline = buffer.lastIndexOf('\n')
      if (lastNewline === -1) continue
      const complete = buffer.slice(0, lastNewline)
      buffer = buffer.slice(lastNewline + 1)

      const lines = complete.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || !trimmed.startsWith('data:')) continue
        const rawData = trimmed.slice(5).trimStart()
        if (rawData === '[DONE]') {
          // Stream marker — finalize anything still open and emit done. Some
          // upstreams send finish_reason AND [DONE]; we guard with
          // messageStopEmitted to avoid double-emit.
          closeOpenTextBlock()
          closeAllToolBlocks()
          if (!messageStopEmitted) {
            messageStopEmitted = true
            callbacks.onEvent({ type: 'done' })
          }
          continue
        }
        try {
          const json = JSON.parse(rawData) as OpenAIChunk
          processChunk(json)
        } catch {
          // Malformed JSON — skip. Local servers are usually tidy but the
          // bytes-stream Rust bridge can split a multi-byte char on a chunk
          // boundary; the next iteration's accumulated buffer recovers.
          continue
        }
      }
    }

    // Flush remaining
    if (buffer.trim().startsWith('data:')) {
      const rawData = buffer.trim().slice(5).trimStart()
      if (rawData !== '[DONE]') {
        try {
          processChunk(JSON.parse(rawData))
        } catch { /* ignore */ }
      }
    }

    // If the upstream closed without a finish_reason or [DONE], close
    // anything open and emit done so the agent doesn't hang waiting.
    closeOpenTextBlock()
    closeAllToolBlocks()
    if (!messageStopEmitted) {
      messageStopEmitted = true
      callbacks.onEvent({ type: 'done' })
    }
    // Suppress unused-var lint — textEmitted is intentional bookkeeping
    // for future extensions (e.g. detecting empty-response cases).
    void textEmitted
  } finally {
    reader.releaseLock()
  }
}

// ── Thinking detector (for DashScope reasoning via <think> tags) ─────────
//
// DashScope's reasoning content arrives as text with <think>...</think> tags
// (not as native Anthropic thinking blocks). This detector extracts thinking
// from text deltas when the backend emits reasoning as text_delta.
//
// Used by processStreamedTurn when the backend emits reasoning_content as
// text instead of a native thinking block.

function partialTagMatch(str: string, tag: string): number {
  const maxLen = Math.min(str.length, tag.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (str.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

export function createThinkingDetector(): {
  process: (text: string) => { reasoning: string; content: string }
} {
  let isInsideThink = false
  let buffer = ''

  return {
    process(text: string): { reasoning: string; content: string } {
      let reasoning = ''
      let content = ''

      buffer += text

      while (buffer.length > 0) {
        if (isInsideThink) {
          const closeIdx = buffer.indexOf(CLOSE_TAG)
          if (closeIdx === -1) {
            const partial = partialTagMatch(buffer, CLOSE_TAG)
            if (partial > 0) {
              reasoning += buffer.slice(0, buffer.length - partial)
              buffer = buffer.slice(buffer.length - partial)
            } else {
              reasoning += buffer
              buffer = ''
            }
            break
          } else {
            reasoning += buffer.slice(0, closeIdx)
            buffer = buffer.slice(closeIdx + CLOSE_TAG.length)
            isInsideThink = false
          }
        } else {
          const openIdx = buffer.indexOf(OPEN_TAG)
          if (openIdx === -1) {
            const partial = partialTagMatch(buffer, OPEN_TAG)
            if (partial > 0) {
              content += buffer.slice(0, buffer.length - partial)
              buffer = buffer.slice(buffer.length - partial)
            } else {
              content += buffer
              buffer = ''
            }
            break
          } else {
            content += buffer.slice(0, openIdx)
            buffer = buffer.slice(openIdx + OPEN_TAG.length)
            isInsideThink = true
          }
        }
      }

      return { reasoning, content }
    },
  }
}
