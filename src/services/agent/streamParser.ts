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
  | { type: 'error'; message: string }
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

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

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
      const inputTokens = msg?.usage?.input_tokens ?? 0
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
      const outputTokens = data.usage?.output_tokens ?? 0
      callbacks.onEvent({
        type: 'message_delta',
        stopReason,
        outputTokens,
      })
      callbacks.onEvent({
        type: 'usage',
        promptTokens: 0,
        completionTokens: outputTokens,
      })
      break
    }

    case 'message_stop': {
      callbacks.onEvent({ type: 'done' })
      break
    }

    case 'error': {
      callbacks.onEvent({
        type: 'error',
        message: data.error?.message ?? JSON.stringify(data),
      })
      break
    }
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
