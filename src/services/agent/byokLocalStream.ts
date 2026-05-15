// Bridge for the Rust `byok_local_chat_stream` command.
//
// The cloud BYOK path uses native fetch() with SSE — works because the worker
// is on a public origin with permissive CORS. Local providers (Ollama, LM
// Studio) can't be hit from the WebView directly: they're cross-origin and
// Ollama 403s by default. We route through Rust instead — no CORS, no setup
// needed by the user.
//
// The Rust side opens the streaming POST and emits Tauri events with raw
// chunk strings. This module wraps those events into a Response-like object
// the existing parseSSEStream / parseOpenAISSEStream can read via getReader().
//
// Why a fake Response: the agent's callAPIOnce path expects a Response with
// .body.getReader(). Mirroring that contract means parseOpenAISSEStream can
// be written symmetric to parseSSEStream — no special Tauri-event awareness.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface StreamEventPayload {
  type: 'chunk' | 'done' | 'error' | 'http_error'
  data?: string
  error?: string
  status?: number
  body?: string
}

export interface LocalStreamResponse {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  // Optional richer error info available when ok=false; mirrors what the
  // Rust side reported so the caller can pick a sensible user-facing
  // message. For network failures (server down) status is 0.
  errorBody?: string
}

export async function streamLocalChat(
  url: string,
  body: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<LocalStreamResponse> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const eventName = `byok-stream-${requestId}`

  // Buffer chunks that arrive before the first reader.read() call, plus
  // status flags the readable stream's pull() consults.
  const queue: string[] = []
  let resolved = false
  let firstResolve: ((response: LocalStreamResponse) => void) | null = null
  let firstResponse: Promise<LocalStreamResponse> = new Promise((res) => {
    firstResolve = res
  })
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  let streamClosed = false
  let httpError: { status: number; body: string } | null = null
  let unlisten: UnlistenFn | null = null
  const encoder = new TextEncoder()

  const cleanup = () => {
    if (unlisten) {
      unlisten()
      unlisten = null
    }
  }

  const closeStream = () => {
    if (streamClosed) return
    streamClosed = true
    streamController?.close()
    cleanup()
  }

  const errorStream = (msg: string) => {
    if (streamClosed) return
    streamClosed = true
    streamController?.error(new Error(msg))
    cleanup()
  }

  unlisten = await listen<StreamEventPayload>(eventName, (event) => {
    const payload = event.payload
    switch (payload.type) {
      case 'chunk': {
        // The first chunk doubles as the "ok" signal — Rust only emits
        // chunks after a 2xx response. Resolve firstResponse on first chunk.
        if (!resolved) {
          resolved = true
          // Build the ReadableStream lazily, draining the queue.
          const readable = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
              for (const queued of queue) {
                controller.enqueue(encoder.encode(queued))
              }
              queue.length = 0
            },
            cancel() {
              closeStream()
            },
          })
          firstResolve?.({ ok: true, status: 200, body: readable })
        }
        if (payload.data) {
          if (streamController) {
            streamController.enqueue(encoder.encode(payload.data))
          } else {
            queue.push(payload.data)
          }
        }
        break
      }
      case 'done': {
        // If the upstream produced zero chunks (rare — empty body), we still
        // need to resolve firstResponse so callers don't hang. Treat empty
        // success as ok with an empty body.
        if (!resolved) {
          resolved = true
          const readable = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          })
          firstResolve?.({ ok: true, status: 200, body: readable })
        } else {
          closeStream()
        }
        break
      }
      case 'http_error': {
        httpError = { status: payload.status ?? 0, body: payload.body ?? '' }
        if (!resolved) {
          resolved = true
          firstResolve?.({
            ok: false,
            status: httpError.status,
            body: null,
            errorBody: httpError.body,
          })
        } else {
          // We were already streaming — turn it into a stream error.
          errorStream(`Upstream returned HTTP ${httpError.status}: ${httpError.body}`)
        }
        break
      }
      case 'error': {
        const msg = payload.error ?? 'unknown stream error'
        if (!resolved) {
          resolved = true
          firstResolve?.({ ok: false, status: 0, body: null, errorBody: msg })
        } else {
          errorStream(msg)
        }
        break
      }
    }
  })

  // Hook abort: when the AbortController fires, close the JS-side stream.
  // The Rust task continues to completion (no kill) — Ollama responses are
  // bounded and the wasted background work has a 5-minute hard cap.
  if (signal) {
    if (signal.aborted) {
      cleanup()
      return { ok: false, status: 0, body: null, errorBody: 'aborted' }
    }
    signal.addEventListener(
      'abort',
      () => {
        if (resolved) {
          errorStream('aborted')
        } else {
          cleanup()
          firstResolve?.({ ok: false, status: 0, body: null, errorBody: 'aborted' })
        }
      },
      { once: true },
    )
  }

  try {
    await invoke('byok_local_chat_stream', {
      input: { requestId, url, headers, body },
    })
  } catch (err) {
    cleanup()
    return {
      ok: false,
      status: 0,
      body: null,
      errorBody: err instanceof Error ? err.message : String(err),
    }
  }

  return firstResponse
}
