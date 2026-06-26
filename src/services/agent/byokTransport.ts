/**
 * BYOK transport — a custom `fetch` for the OpenAI SDK that talks DIRECTLY to
 * the user's provider, CORS-free, via the Rust streaming command.
 *
 * Why Rust and not browser fetch: cloud providers (Anthropic / Google /
 * DashScope) don't send CORS headers for the WebView origin, so a native
 * `fetch` from `http://localhost:14300` is blocked. `byok_chat_stream` (Rust)
 * opens the streaming POST with reqwest (no CORS) and relays chunks as Tauri
 * events; this module bridges those events back into a WHATWG `Response` so the
 * OpenAI SDK's streaming + non-streaming code paths work unchanged.
 *
 * This keeps BYOK strictly IDE → SDK → provider: the request never touches the
 * TM worker. Only the local Rust process speaks to the provider, with the
 * user's own key.
 *
 * Anthropic: `apiShape: 'anthropic'` rewrites the request to the Messages API
 * and translates the response (SSE or JSON) back to OpenAI shape — see
 * `anthropicAdapter.ts`.
 */

import { invoke } from '@/utils/invokeMetrics'
import { listen } from '@tauri-apps/api/event'
import {
  toAnthropicRequest,
  anthropicHeaders,
  anthropicSSEToOpenAISSE,
  anthropicResponseToOpenAI,
} from './anthropicAdapter'

export type ByokApiShape = 'openai_compat' | 'anthropic'

interface ByokStreamEvent {
  type: 'chunk' | 'done' | 'error' | 'http_error'
  data?: string
  error?: string
  status?: number
  body?: string
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `byok-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }
}

/** Normalise the SDK's RequestInit headers (Headers | array | object) to a plain map. */
function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v
    })
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v
  } else {
    Object.assign(out, h as Record<string, string>)
  }
  return out
}

function dropUnsafeTransportHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    if (
      lower === 'content-length' ||
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'host' ||
      lower === 'expect' ||
      lower === 'te' ||
      lower === 'trailer' ||
      lower === 'upgrade'
    ) {
      delete headers[key]
    }
  }
}

/**
 * Build a `fetch` implementation bound to one BYOK provider. Pass to
 * `new OpenAI({ fetch: createByokFetch({...}) })`.
 *
 * @param opts.expectedHost - host of the provider's baseURL; the Rust egress
 *   guard refuses any request whose host doesn't match (or isn't localhost).
 * @param opts.apiShape - 'anthropic' enables request/response translation.
 */
export function createByokFetch(opts: { expectedHost: string; apiShape: ByokApiShape }) {
  const isAnthropic = opts.apiShape === 'anthropic'

  return async function byokFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const headers = headersToObject(init?.headers)
    let body = typeof init?.body === 'string' ? init.body : init?.body != null ? String(init.body) : ''

    // Parse the request body once — we need `stream` to pick the response mode,
    // and (for Anthropic) to translate it.
    let parsedBody: Record<string, unknown> = {}
    try {
      parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    } catch {
      parsedBody = {}
    }
    const wantsStream = parsedBody.stream === true

    if (isAnthropic) {
      // Rewrite path → /v1/messages (the SDK appended /chat/completions).
      try {
        const u = new URL(url)
        u.pathname = '/v1/messages'
        u.search = ''
        url = u.toString()
      } catch {
        /* leave url as-is */
      }
      body = JSON.stringify(toAnthropicRequest(parsedBody))
      // Anthropic auth is x-api-key, not Authorization: Bearer. The SDK set
      // Authorization from the client apiKey; move it over.
      const auth = headers['authorization'] ?? headers['Authorization']
      if (auth) {
        headers['x-api-key'] = auth.replace(/^Bearer\s+/i, '')
        delete headers['authorization']
        delete headers['Authorization']
      }
      Object.assign(headers, anthropicHeaders())
    }
    // The body may have been rewritten after the SDK created headers
    // (Anthropic shape translation). Let reqwest compute framing from the
    // actual body instead of forwarding stale/hop-by-hop headers.
    dropUnsafeTransportHeaders(headers)

    const signal = init?.signal ?? undefined
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const requestId = randomId()
    const eventName = `byok-stream-${requestId}`

    let resolveFetch!: (r: Response) => void
    let rejectFetch!: (e: unknown) => void
    const fetchPromise = new Promise<Response>((res, rej) => {
      resolveFetch = res
      rejectFetch = rej
    })

    let settled = false
    let unlisten: (() => void) | null = null
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    // Non-stream accumulation (compact / title one-shots).
    let buffered = ''

    const cleanup = () => {
      try {
        unlisten?.()
      } catch {
        /* ignore */
      }
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const enc = new TextEncoder()

    // Streaming Response: a ReadableStream fed by chunk events. For Anthropic,
    // pipe the raw SSE through the shape-translation transform.
    const rawStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        void invoke('byok_chat_abort', { requestId }).catch(() => {})
        cleanup()
      },
    })
    const makeStreamingResponse = () => {
      const out = isAnthropic ? rawStream.pipeThrough(anthropicSSEToOpenAISSE()) : rawStream
      return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    // Non-stream Response: built once all bytes are in.
    const makeBufferedResponse = (): Response => {
      if (isAnthropic) {
        try {
          const translated = anthropicResponseToOpenAI(JSON.parse(buffered || '{}'))
          return new Response(JSON.stringify(translated), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch {
          return new Response(buffered, { status: 200, headers: { 'content-type': 'application/json' } })
        }
      }
      return new Response(buffered, { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const onAbort = () => {
      void invoke('byok_chat_abort', { requestId }).catch(() => {})
      if (!settled) {
        settled = true
        rejectFetch(new DOMException('Aborted', 'AbortError'))
      }
      try {
        streamController?.error(new DOMException('Aborted', 'AbortError'))
      } catch {
        /* ignore */
      }
      cleanup()
    }
    if (signal) signal.addEventListener('abort', onAbort)

    const handler = (payload: ByokStreamEvent) => {
      switch (payload.type) {
        case 'chunk':
          if (wantsStream) {
            if (!settled) {
              settled = true
              resolveFetch(makeStreamingResponse())
            }
            try {
              streamController?.enqueue(enc.encode(payload.data ?? ''))
            } catch {
              /* consumer gone */
            }
          } else {
            buffered += payload.data ?? ''
          }
          break
        case 'done':
          if (wantsStream) {
            if (!settled) {
              settled = true
              resolveFetch(makeStreamingResponse())
            }
            try {
              streamController?.close()
            } catch {
              /* ignore */
            }
          } else if (!settled) {
            settled = true
            resolveFetch(makeBufferedResponse())
          }
          cleanup()
          break
        case 'error':
          if (!settled) {
            settled = true
            rejectFetch(new Error(payload.error || 'BYOK stream error'))
          } else {
            try {
              streamController?.error(new Error(payload.error || 'BYOK stream error'))
            } catch {
              /* ignore */
            }
          }
          cleanup()
          break
        case 'http_error':
          // Resolve with the error Response so the OpenAI SDK builds the right
          // APIError/RateLimitError subclass and query.ts's retry logic kicks in.
          if (!settled) {
            settled = true
            resolveFetch(
              new Response(payload.body ?? '', {
                status: payload.status || 500,
                headers: { 'content-type': 'application/json' },
              }),
            )
          } else {
            try {
              streamController?.error(new Error(`HTTP ${payload.status ?? '?'}`))
            } catch {
              /* ignore */
            }
          }
          cleanup()
          break
      }
    }

    // Subscribe BEFORE invoking so the Rust task can't emit before we listen.
    unlisten = await listen<ByokStreamEvent>(eventName, (e) => handler(e.payload))
    void invoke('byok_chat_stream', {
      input: { requestId, url, headers, body, expectedHost: opts.expectedHost },
    }).catch((err) => {
      if (!settled) {
        settled = true
        rejectFetch(err instanceof Error ? err : new Error(String(err)))
      }
      cleanup()
    })

    return fetchPromise
  }
}
