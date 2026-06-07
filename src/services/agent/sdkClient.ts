/**
 * SDK Client Factory — creates a pre-configured OpenAI SDK instance
 * that connects to the TM Code Worker endpoint.
 *
 * The Worker handles JWT validation, billing, and API key injection.
 * The SDK connects directly to the Worker's /v1/chat/completions endpoint.
 *
 * Auth flow:
 *   1. IDE gets Firebase JWT token from FirebaseAuthService
 *   2. Token is passed as `apiKey` to the SDK (maps to `Authorization: Bearer` header)
 *   3. Worker validates the token and injects the real upstream API key
 */

import OpenAI from 'openai'
import { resolveWorkerUrl } from '../../utils/devUrls'

// ── Constants ──

const DEFAULT_MAX_RETRIES = 2
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
 * Create an OpenAI SDK client configured to talk to the TM Code Worker.
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
  const workerUrl = options?.baseURL ?? resolveWorkerUrl()

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
    maxRetries: 1, // Sub-agents fail fast
    timeout: options?.timeout ?? 120_000, // 2 min default for sub-agents
    ...options,
  })
}
