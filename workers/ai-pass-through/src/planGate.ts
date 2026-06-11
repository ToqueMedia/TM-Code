import type { Env, Fetcher } from './types'

/**
 * Gate de plano para o TM Speed.
 *
 * O data-plane não conhece planos (auth dá só o userId), por isso lê o
 * `userPlan` do doc `users/{uid}` via Firestore REST usando o PRÓPRIO ID token
 * do utilizador — as security rules já permitem self-read (a IDE lê/escreve o
 * mesmo doc client-side, ex.: `tmSpeedEnabled`).
 *
 * Decisões deliberadas:
 *  - Plano não elegível ou lookup falhado → degrada para o modelo normal em
 *    vez de 403. Um 403 partiria o chat inteiro de um utilizador que fez
 *    downgrade com `tmSpeedEnabled` ainda persistido (a IDE continua a enviar
 *    o header). Degradar é abuse-safe: o multiplicador de cobrança 3x só é
 *    aplicado quando `X-TM-Speed-Applied: true` volta na resposta.
 *  - Cache em memória por utilizador (60s) para não pagar um round-trip ao
 *    Firestore em cada turno do agent loop.
 */

const PLAN_CACHE_MS = 60_000
const SPEED_ALLOWED_PLANS = new Set(['pro', 'max'])
const DEFAULT_FIRESTORE_BASE = 'https://firestore.googleapis.com'

let planCache = new Map<string, { allowed: boolean; expiresAt: number }>()

export function clearPlanCache(): void {
  planCache = new Map()
}

export async function isSpeedAllowedForUser(
  request: Request,
  env: Env,
  userId: string,
  fetcher: Fetcher,
  now = Date.now(),
): Promise<boolean> {
  const cached = planCache.get(userId)
  if (cached && cached.expiresAt > now) return cached.allowed

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return false

  const idToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!idToken) return false

  const base = typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE
    ? env.FIRESTORE_REST_BASE.replace(/\/+$/, '')
    : DEFAULT_FIRESTORE_BASE
  const url = `${base}/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(userId)}?mask.fieldPaths=userPlan`

  let allowed = false
  try {
    const response = await fetcher.fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${idToken}` },
    })
    if (response.ok) {
      const doc = await response.json() as { fields?: { userPlan?: { stringValue?: string } } }
      const plan = doc.fields?.userPlan?.stringValue
      allowed = typeof plan === 'string' && SPEED_ALLOWED_PLANS.has(plan)
    }
  } catch {
    allowed = false
  }

  planCache.set(userId, { allowed, expiresAt: now + PLAN_CACHE_MS })
  return allowed
}
