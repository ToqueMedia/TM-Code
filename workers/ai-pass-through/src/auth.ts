import { HttpError } from './errors'
import type { AuthenticatedUser, Env } from './types'

function bearerToken(request: Request): string {
  const auth = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  if (!match) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }
  return match[1].trim()
}

function base64UrlDecode(input: string): ArrayBuffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function jsonFromBase64Url(input: string): Record<string, unknown> {
  const decoded = new TextDecoder().decode(base64UrlDecode(input))
  const parsed = JSON.parse(decoded) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JWT part is not an object')
  }
  return parsed as Record<string, unknown>
}

// ── JWKS cache (por isolate) ──────────────────────────────────────────────
//
// Antes, CADA pedido fazia um fetch ao JWKS do Google sem timeout — um
// subrequest de latência pura por pedido e um ponto onde um stall do Google
// pendurava o worker inteiro (hang detector do runtime: "code had hung and
// would never generate a response"). As keys do securetoken rodam devagar e
// vêm com cache-control max-age de horas, por isso: cache por isolate com o
// TTL do header, timeout curto no fetch, e fallback para a cache stale numa
// falha de rede — auth degradar por causa de um blip do JWKS seria pior do
// que usar keys ligeiramente antigas. Um `kid` desconhecido com cache fresca
// é 401 SEM refetch (token forjado não pode forçar cache-bypass por pedido).

type JwksKey = JsonWebKey & { kid?: string }

const JWKS_FETCH_TIMEOUT_MS = 10_000
const JWKS_FALLBACK_TTL_MS = 60 * 60 * 1000
const JWKS_MAX_TTL_MS = 24 * 60 * 60 * 1000

let jwksCache: { url: string; keys: JwksKey[]; expiresAtMs: number } | null = null

export function clearJwksCache(): void {
  jwksCache = null
}

async function fetchJwks(url: string): Promise<JwksKey[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`JWKS fetch failed (${response.status})`)
  }
  const jwks = await response.json() as { keys?: JwksKey[] }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error('JWKS payload has no keys')
  }
  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')
  const ttlMs = maxAge
    ? Math.min(parseInt(maxAge[1], 10) * 1000, JWKS_MAX_TTL_MS)
    : JWKS_FALLBACK_TTL_MS
  jwksCache = { url, keys: jwks.keys, expiresAtMs: Date.now() + ttlMs }
  return jwks.keys
}

async function getJwksKeys(url: string): Promise<JwksKey[]> {
  const cached = jwksCache && jwksCache.url === url ? jwksCache : null
  if (cached && cached.expiresAtMs > Date.now()) return cached.keys
  try {
    return await fetchJwks(url)
  } catch {
    if (cached) return cached.keys
    throw new HttpError(503, 'tm_auth_config_error', 'Unable to verify user session.')
  }
}

async function verifyFirebaseJwt(token: string, env: Env): Promise<AuthenticatedUser> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = jsonFromBase64Url(parts[0])
    payload = jsonFromBase64Url(parts[1])
  } catch {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  if (header.alg !== 'RS256') {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) {
    throw new HttpError(500, 'tm_auth_config_error', 'Firebase project is not configured.')
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const aud = payload.aud
  const iss = payload.iss
  const sub = payload.sub
  const exp = payload.exp
  const issuer = typeof env.FIREBASE_ISSUER === 'string'
    ? env.FIREBASE_ISSUER
    : `https://securetoken.google.com/${projectId}`

  if (
    aud !== projectId ||
    iss !== issuer ||
    typeof sub !== 'string' ||
    sub.length === 0 ||
    typeof exp !== 'number' ||
    exp <= nowSeconds
  ) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  const jwksUrl = typeof env.FIREBASE_JWKS_URL === 'string'
    ? env.FIREBASE_JWKS_URL
    : 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

  const keys = await getJwksKeys(jwksUrl)
  const key = keys.find(candidate => candidate.kid === header.kid)
  if (!key) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signatureOk = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )

  if (!signatureOk) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  return { userId: sub }
}

function verifyFirebaseEmulatorJwt(token: string): AuthenticatedUser {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  let payload: Record<string, unknown>
  try {
    payload = jsonFromBase64Url(parts[1])
  } catch {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const exp = payload.exp
  if (typeof exp === 'number' && exp <= nowSeconds) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  const userId = payload.sub || payload.user_id || payload.uid
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  return { userId }
}

export async function authenticateUser(request: Request, env: Env): Promise<AuthenticatedUser> {
  const token = bearerToken(request)

  if (env.AUTH_MODE === 'firebase_emulator') {
    return verifyFirebaseEmulatorJwt(token)
  }

  if (env.AUTH_MODE === 'test_static') {
    if (typeof env.TEST_USER_TOKEN === 'string' && token === env.TEST_USER_TOKEN) {
      return { userId: 'test-user' }
    }
    throw new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.')
  }

  return verifyFirebaseJwt(token, env)
}
