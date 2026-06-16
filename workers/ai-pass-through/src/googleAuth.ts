/**
 * Service-account access tokens via WebCrypto (sem dependências).
 *
 * Porte mínimo do `googleAuth.ts` do control-plane (toquemedia-studio-api):
 * assina um JWT RS256 com a private key da service account e troca-o por um
 * access token OAuth2. Usado pelos commits/reads de billing ao Firestore —
 * com SA os pedidos ignoram Security Rules + App Check (modelo de confiança
 * correto para infraestrutura), e permitem FECHAR as rules de escrita dos
 * campos de billing ao cliente sem partir o worker.
 *
 * Quando `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` não estão definidos,
 * os callers degradam para o ID token do próprio utilizador (self-read/write
 * permitido pelas rules atuais) — o deploy funciona ANTES de o secret ser
 * adicionado, e endurece automaticamente quando for.
 */

import type { Env, Fetcher } from './types'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OAUTH_SCOPE_DATASTORE = 'https://www.googleapis.com/auth/datastore'
/** Scope exigido pela Vertex AI (authScheme google_oauth em headers.ts). */
export const OAUTH_SCOPE_CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'

// Um stall do endpoint OAuth não pode pendurar o pedido inteiro (este mint
// corre no pré-voo de billing, ANTES da resposta) — timeout curto; o throw
// é apanhado pelos callers em billing.ts, que degradam sem partir o chat.
const OAUTH_FETCH_TIMEOUT_MS = 10_000

// O mint corre síncrono no pré-voo do pedido e a perna de rede CF→Google pode
// estabolar (redes lentas/intermitentes — ver [[gemini-via-vertex-google-oauth]]).
// Um único timeout NÃO pode condenar o pedido (o erro é `retryable`): tentamos
// de novo SÓ erros transitórios (timeout/rede/5xx/429), com backoff e um teto
// total para um bloqueio DURO falhar em ~20s em vez de ~30s. Um 4xx (ex.:
// invalid_grant — SA inválida) é permanente → falha já, sem retry.
const OAUTH_MINT_MAX_ATTEMPTS = 3
const OAUTH_MINT_BACKOFFS_MS = [400, 1200] as const
const OAUTH_MINT_TOTAL_BUDGET_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** AbortSignal.timeout → DOMException 'TimeoutError'; rede → TypeError; abort
 *  manual → 'AbortError'. Todos transitórios → vale a pena re-tentar. */
function isTransientMintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError')
  )
}

const tokenCache = new Map<string, { token: string; expiresAtMs: number }>()

export function clearAccessTokenCache(): void {
  tokenCache.clear()
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

/** PEM PKCS8 → CryptoKey. Tolerante a `\n` literais vindos de env vars. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, '\n')
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export async function mintAccessToken(
  clientEmail: string,
  privateKeyPem: string,
  fetcher: Fetcher,
  scope: string = OAUTH_SCOPE_DATASTORE,
): Promise<string> {
  const now = Date.now()
  const cacheKey = `${clientEmail}|${scope}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs > now + 60_000) return cached.token

  const iat = Math.floor(now / 1000)
  const header = base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' })
  const payload = base64UrlEncodeJson({
    iss: clientEmail,
    scope,
    aud: OAUTH_TOKEN_URL,
    iat,
    exp: iat + 3600,
  })
  const signingInput = `${header}.${payload}`
  const key = await importPrivateKey(privateKeyPem)
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )
  const assertion = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })

  const mintStart = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= OAUTH_MINT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // Bloqueio duro: para de tentar quando já gastámos o teto total, em vez
      // de pendurar o caller ~30s antes do 502.
      if (Date.now() - mintStart > OAUTH_MINT_TOTAL_BUDGET_MS) break
      await sleep(OAUTH_MINT_BACKOFFS_MS[attempt - 2] ?? OAUTH_MINT_BACKOFFS_MS[OAUTH_MINT_BACKOFFS_MS.length - 1])
    }
    try {
      const res = await fetcher.fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        // Sinal novo por tentativa — cada uma ganha os seus 10s.
        signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
      })
      if (res.ok) {
        const data = await res.json() as { access_token: string; expires_in: number }
        tokenCache.set(cacheKey, {
          token: data.access_token,
          expiresAtMs: Date.now() + (data.expires_in - 60) * 1000,
        })
        return data.access_token
      }
      const detail = await res.text().catch(() => '')
      lastError = new Error(`OAuth2 token exchange failed (${res.status}): ${detail.slice(0, 200)}`)
      // 5xx/429 → transitório (re-tenta); 4xx → permanente (falha já).
      if (!(res.status >= 500 || res.status === 429)) break
    } catch (err) {
      lastError = err
      if (!isTransientMintError(err)) break
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('OAuth2 token exchange failed (no response)')
}

/**
 * Headers de auth para o Firestore REST: service account quando configurada,
 * senão o ID token do utilizador (sujeito a Security Rules — paridade com o
 * comportamento atual do planGate).
 */
export async function resolveFirestoreAuthHeaders(
  env: Env,
  idToken: string,
  fetcher: Fetcher,
): Promise<Record<string, string>> {
  // Emulador (FIRESTORE_REST_BASE definido): `Bearer owner` é o token de
  // bypass admin do Firestore Emulator — mesmo padrão do control-plane.
  // Sem ele, as Security Rules carregadas no emulador negariam as escritas
  // de tokenBudget tal como em produção.
  if (typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE !== '') {
    return { authorization: 'Bearer owner', 'content-type': 'application/json' }
  }
  const email = typeof env.FIREBASE_CLIENT_EMAIL === 'string' ? env.FIREBASE_CLIENT_EMAIL : ''
  const key = typeof env.FIREBASE_PRIVATE_KEY === 'string' ? env.FIREBASE_PRIVATE_KEY : ''
  if (email && key) {
    const token = await mintAccessToken(email, key, fetcher)
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  }
  return { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' }
}
