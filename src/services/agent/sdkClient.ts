/**
 * SDK Client Factory — creates a pre-configured OpenAI SDK instance
 * that connects to the TM Code AI data-plane Worker endpoint.
 *
 * The Worker validates the user token, injects the active provider API key,
 * injects the active model from Control Plane config, and passes the stream
 * through without billing/parser mutations.
 *
 * Auth flow:
 *   1. IDE gets Firebase JWT token from FirebaseAuthService
 *   2. Token is passed as `apiKey` to the SDK (maps to `Authorization: Bearer` header)
 *   3. Worker validates the token and injects the real upstream API key
 */

import OpenAI, { type ClientOptions } from 'openai'
import { resolveAIWorkerUrl } from '../../utils/devUrls'
import { createByokFetch, type ByokApiShape } from './byokTransport'

// ── Constants ──

const DEFAULT_MAX_RETRIES = 0
const DEFAULT_TIMEOUT_MS = 300_000 // 5 min (matches claude-vaz)

// ── Helpers ──

/**
 * Ensure the base URL includes the `/v1` path prefix that the OpenAI SDK
 * expects to strip before appending `/chat/completions`.
 *
 * Without this, the SDK sends `POST {baseURL}/chat/completions` which 404s
 * on the Worker (which listens on `/v1/chat/completions`).
 *
 * Normalisation rules:
 *   - Strip trailing slashes
 *   - Append `/v1` if not already present
 */
function normalizeBaseURL(raw: string): string {
  let url = raw.replace(/\/+$/, '')
  if (!url.endsWith('/v1')) {
    url += '/v1'
  }
  return url
}

// ── Factory ──

/**
 * Create an OpenAI SDK client configured to talk to the TM Code AI data plane.
 *
 * @param authToken - Firebase JWT token (or session token) for Worker auth.
 *   The SDK sends this as the `Authorization: Bearer` header. The Worker validates it
 *   and injects the real upstream API key before forwarding to the provider.
 * @param options - Optional overrides for maxRetries, timeout, etc.
 */
export function createAgentClient(
  authToken: string,
  options?: {
    maxRetries?: number
    timeout?: number
    baseURL?: string
  },
): OpenAI {
  const workerUrl = options?.baseURL ?? resolveAIWorkerUrl()

  return new OpenAI({
    baseURL: normalizeBaseURL(workerUrl),
    apiKey: authToken,
    dangerouslyAllowBrowser: true,
    maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
    defaultHeaders: {
      'x-app': 'tm-code',
    },
  })
}

/**
 * Create a lightweight client for sub-agents.
 *
 * Sub-agents use the same auth token and endpoint but may have different
 * retry/timeout settings.
 */
export function createSubAgentClient(
  authToken: string,
  options?: {
    maxRetries?: number
    timeout?: number
    baseURL?: string
  },
): OpenAI {
  return createAgentClient(authToken, {
    maxRetries: 0,
    timeout: options?.timeout ?? 120_000, // 2 min default for sub-agents
    ...options,
  })
}

/**
 * Create an OpenAI SDK client for the BYOK DIRECT path — IDE → SDK → provider,
 * bypassing the TM worker entirely.
 *
 * Differences from `createAgentClient`:
 *   - `baseURL` is the provider's own URL, used RAW (only trailing slash
 *     trimmed). We must NOT force-append `/v1` like `normalizeBaseURL` does —
 *     that breaks Gemini (`/v1beta/openai`) and double-`/v1`s DashScope. The SDK
 *     appends `/chat/completions` itself.
 *   - `apiKey` is the user's own key (read just-in-time from the OS keychain).
 *     The SDK sends it as `Authorization: Bearer`; the Anthropic transport
 *     rewrites that to `x-api-key`.
 *   - `fetch` is the Rust-backed CORS-free streaming transport. Anthropic
 *     request/response translation happens inside it (apiShape).
 */
export function createByokAgentClient(params: {
  baseURL: string
  apiKey: string
  apiShape: ByokApiShape
  extraHeaders?: Record<string, string>
  maxRetries?: number
  timeout?: number
}): OpenAI {
  const baseURL = params.baseURL.replace(/\/+$/, '')
  let expectedHost = ''
  try {
    expectedHost = new URL(baseURL).host
  } catch {
    expectedHost = ''
  }
  return new OpenAI({
    baseURL,
    // SDK requires a non-empty apiKey; local providers (no auth) get a
    // placeholder the upstream ignores.
    apiKey: params.apiKey || 'tm-byok-local',
    dangerouslyAllowBrowser: true,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: params.timeout ?? DEFAULT_TIMEOUT_MS,
    // The OpenAI SDK's `Fetch` type uses its own URLLike; our transport returns
    // a real Response from (url, init). Cast through the SDK option type — the
    // runtime contract (a streaming Response) is exactly what the SDK consumes.
    fetch: createByokFetch({ expectedHost, apiShape: params.apiShape }) as unknown as ClientOptions['fetch'],
    defaultHeaders: {
      'x-app': 'tm-code',
      ...(params.extraHeaders ?? {}),
    },
  })
}
