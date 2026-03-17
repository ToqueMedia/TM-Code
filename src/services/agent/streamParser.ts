// SSE Stream Parser for OpenAI-compatible streaming responses
//
// Parses chunks like:
// data: {"id":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
// data: [DONE]

export type StreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; argsDelta: string }
  | { type: 'finish'; reason: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

interface StreamParserCallbacks {
  onEvent: (event: StreamEvent) => void
}

function processSSELines(
  rawText: string,
  callbacks: StreamParserCallbacks
): boolean {
  const lines = rawText.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') continue
    if (trimmed === 'data: [DONE]') {
      callbacks.onEvent({ type: 'done' })
      return true // stream finished
    }
    if (!trimmed.startsWith('data: ')) continue

    let json: any
    try {
      json = JSON.parse(trimmed.slice(6))
    } catch {
      // Skip malformed JSON — don't swallow callback errors
      continue
    }
    processChunk(json, callbacks)
  }
  return false
}

export async function parseSSEStream(
  response: Response,
  callbacks: StreamParserCallbacks
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Split keeping the last (possibly incomplete) line in the buffer
      const lastNewline = buffer.lastIndexOf('\n')
      if (lastNewline === -1) continue

      const complete = buffer.slice(0, lastNewline)
      buffer = buffer.slice(lastNewline + 1)

      if (processSSELines(complete, callbacks)) return
    }

    // Process any remaining data in the buffer after stream ends
    if (buffer.trim()) {
      processSSELines(buffer, callbacks)
    }
  } finally {
    reader.releaseLock()
  }
}

function processChunk(
  chunk: any,
  callbacks: StreamParserCallbacks
): void {
  const choice = chunk.choices?.[0]
  if (!choice) {
    // Usage-only chunk (no choices)
    if (chunk.usage) {
      callbacks.onEvent({
        type: 'usage',
        promptTokens: chunk.usage.prompt_tokens || 0,
        completionTokens: chunk.usage.completion_tokens || 0,
      })
    }
    return
  }

  const delta = choice.delta
  if (!delta) return

  // Text content
  if (delta.content) {
    callbacks.onEvent({ type: 'text_delta', content: delta.content })
  }

  // Reasoning (native field: Qwen, DeepSeek)
  if (delta.reasoning_content) {
    callbacks.onEvent({ type: 'reasoning_delta', content: delta.reasoning_content })
  }

  // Tool calls (incremental)
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        callbacks.onEvent({
          type: 'tool_call_start',
          index: tc.index,
          id: tc.id,
          name: tc.function.name,
        })
      }
      if (tc.function?.arguments) {
        callbacks.onEvent({
          type: 'tool_call_args_delta',
          index: tc.index,
          argsDelta: tc.function.arguments,
        })
      }
    }
  }

  // Finish reason
  if (choice.finish_reason) {
    callbacks.onEvent({ type: 'finish', reason: choice.finish_reason })
  }

  // Usage (appears in last chunk for some providers)
  if (chunk.usage) {
    callbacks.onEvent({
      type: 'usage',
      promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0,
    })
  }
}

// Returns the length of the longest suffix of `str` that is a prefix of `tag`
function partialTagMatch(str: string, tag: string): number {
  const maxLen = Math.min(str.length, tag.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (str.endsWith(tag.slice(0, len))) {
      return len
    }
  }
  return 0
}

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

// Detects <think>...</think> blocks in content stream
// Handles partial tags split across chunks (e.g. "<thi" + "nk>...")
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
            // Check if buffer ends with a partial </think> match
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
            // Check if buffer ends with a partial <think> match
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
