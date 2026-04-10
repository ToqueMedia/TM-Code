/**
 * CORS-free fetch via Tauri's Rust HTTP proxy.
 *
 * In production, the WebView runs at http://localhost:14300 (tauri-plugin-localhost),
 * so browser fetch() to external APIs is blocked by CORS. This utility routes
 * requests through the Rust `http_client_request` command, which uses reqwest
 * and is not subject to browser CORS restrictions.
 *
 * Only for non-streaming requests — SSE/streaming still uses native fetch().
 */

import { invoke } from '@tauri-apps/api/core'

interface TauriFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutSecs?: number
  /**
   * Optional AbortSignal for caller-driven cancellation. The Rust-side
   * `http_client_request` does not support mid-flight cancellation, so this
   * is implemented as a JS-level Promise.race: when the signal fires, the
   * caller's await rejects immediately, but the Rust HTTP request continues
   * running until natural completion (its result is discarded).
   *
   * Acceptable trade-off: HTTP requests are bounded by `timeoutSecs` (max
   * 30s default), so the wasted background work has a hard cap.
   */
  signal?: AbortSignal
}

interface RustHttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  durationMs: number
  sizeBytes: number
}

/**
 * Fetch a URL through Rust (CORS-free). Returns a minimal Response-like object.
 * Use for non-streaming API calls only — SSE/streaming still needs native fetch.
 */
export async function tauriFetch(url: string, opts: TauriFetchOptions = {}): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  // Pre-check abort signal before kicking off the Rust round-trip.
  if (opts.signal?.aborted) {
    throw new DOMException('Request aborted before send', 'AbortError')
  }

  const invokePromise = invoke<RustHttpResponse>('http_client_request', {
    input: {
      method: opts.method || 'GET',
      url,
      headers: opts.headers || {},
      body: opts.body || null,
      timeoutSecs: opts.timeoutSecs || 30,
    },
  })

  // Passive observer to ensure no unhandled-rejection warning surfaces if
  // the abort race wins and invokePromise later rejects (network error
  // arriving after the abort path already returned). Modern V8 typically
  // tracks Promise.race observers but this catch is cheap belt-and-suspenders
  // that works across runtimes. The catch fires for ANY rejection, not only
  // the abort case — Promise.race also observes the same rejection so the
  // outer await still throws normally when abort hasn't won.
  if (opts.signal) {
    invokePromise.catch(() => { /* passive — error also flows through Promise.race */ })
  }

  let result: RustHttpResponse
  if (opts.signal) {
    const signal = opts.signal
    result = await Promise.race([
      invokePromise,
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Request aborted', 'AbortError')),
          { once: true },
        )
      }),
    ])
  } else {
    result = await invokePromise
  }

  const ok = result.status >= 200 && result.status < 300

  return {
    ok,
    status: result.status,
    json: async () => JSON.parse(result.body),
    text: async () => result.body,
  }
}
