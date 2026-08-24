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
    /**
     * Id da sessão do chat — vira `x-tm-session-id`, que o data-plane usa
     * como chave de AFINIDADE no Cloudflare Workers AI (2026-08-11).
     *
     * PORQUÊ: o prefix cache do Workers AI só acerta quando o pedido aterra na
     * instância que tem os tensores. A afinidade por UTILIZADOR resolveu-o em
     * parte (25,2% → 54,6% numa sessão de um só run) mas degrada com o número
     * de runs, porque todos partilham a mesma chave e despejam o prefixo uns
     * dos outros:
     *   1 run  → 54,6%      5 runs → 36,2%      9 runs → 33,6%
     * (prefixo byte-estável em todas — um só promptPrefixHash por sessão.)
     * Uma chave por sessão dá a cada run a sua instância e o seu prefixo.
     */
    sessionId?: string
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
      ...(options?.sessionId ? { 'x-tm-session-id': options.sessionId } : {}),
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
    /** Ver createAgentClient — mesma chave de afinidade do Workers AI. */
    sessionId?: string
  },
): OpenAI {
  return createAgentClient(authToken, {
    maxRetries: 0,
    timeout: options?.timeout ?? 120_000, // 2 min default for sub-agents
    ...options,
  })
}

/**
 * Normalise a BYOK baseURL for the OpenAI SDK.
 *
 * The OpenAI SDK appends `/chat/completions` to whatever baseURL it gets, so
 * the conventional API root for OpenAI-compatible providers is `…/v1`. Local
 * providers (Ollama, LM Studio) expose `/v1/chat/completions` at the same host,
 * but users (and our own defaults until now) often store `http://localhost:11434`
 * without the suffix — producing a 404 upstream.
 *
 * Gemini breaks the naive "always append /v1" rule because its OpenAI-compat
 * root is `/v1beta/openai`. Rule: only append `/v1` when the path does NOT
 * already contain `/v1` AND the host is local (`localhost` or `127.0.0.1`).
 * Local providers are OpenAI-compat by definition and have no exotic roots.
 */
export function normalizeByokBaseURL(baseURL: string, apiShape: ByokApiShape): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (apiShape !== 'openai_compat') return trimmed
  try {
    const u = new URL(trimmed)
    const isLocal =
      u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
    if (isLocal && !u.pathname.includes('/v1')) {
      return `${trimmed}/v1`
    }
  } catch {
    /* malformed URL — fall through and let the SDK fail cleanly */
  }
  return trimmed
}

/**
 * Create an OpenAI SDK client for the BYOK DIRECT path — IDE → SDK → provider,
 * bypassing the TM worker entirely.
 *
 * Differences from `createAgentClient`:
 *   - `baseURL` is the provider's own URL, normalised for OpenAI-compatible
 *     providers (local hosts get `/v1` appended when missing). Gemini's
 *     `/v1beta/openai` is preserved.
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
  const baseURL = normalizeByokBaseURL(params.baseURL, params.apiShape)
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
