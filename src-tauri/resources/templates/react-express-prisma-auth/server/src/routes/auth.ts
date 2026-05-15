// Auth proxy routes. Implements the contract described in the
// `auth-proxy` skill: Identity Toolkit REST exchange + JWT verify + DB upsert.
//
// Hard rules baked in:
//  - tenantId is REQUIRED on every signInWithIdp/signUp/signInWithPassword call
//  - env vars are read DENTRO dos handlers (not at module top-level) so they
//    cannot become undefined due to import ordering
//  - VITE_* are treated as fallbacks; GIP_* mirrors are the canonical source
import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { prisma } from '../lib/prisma.js'
import { optionalAuth, verifyAuth } from '../middleware/auth.js'

const router = Router()

// Per-IP rate limit on credential-handling endpoints. Keep separate from a
// global limiter so /sync and /me are not throttled when the same user is
// just refreshing the dashboard.
const credentialLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
})

interface GipConfig {
  apiKey: string
  tenantId: string
  projectId: string
}

// Identity Toolkit base URL. The override exists for offline e2e tests —
// production never sets it so the real Google endpoint is used.
function itkBase(): string {
  return process.env.ITK_BASE_URL_OVERRIDE || 'https://identitytoolkit.googleapis.com/v1'
}

function gipConfig(): GipConfig {
  const apiKey = process.env.GIP_FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY
  const tenantId = process.env.GIP_TENANT_ID || process.env.VITE_GIP_TENANT_ID
  const projectId = process.env.GCP_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID
  if (!apiKey || !tenantId || !projectId) {
    throw new Error(`${GIP_ENV_MISSING_PREFIX} — check provision_auth ran and --env-file is wired`)
  }
  return { apiKey, tenantId, projectId }
}

interface ITKError {
  error?: { message?: string; code?: number }
}

function mapItkError(
  code: string | undefined,
  itkStatus: number
): { status: number; message: string } {
  // Known business-logic codes (user/credential errors) — explicit mapping.
  switch (code) {
    case 'EMAIL_EXISTS':
      return { status: 409, message: 'Email already registered' }
    case 'WEAK_PASSWORD':
      return { status: 400, message: 'Password must be at least 6 characters' }
    case 'INVALID_EMAIL':
      return { status: 400, message: 'Invalid email address' }
    case 'OPERATION_NOT_ALLOWED':
      return { status: 403, message: 'Account creation is disabled' }
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_ID_TOKEN':
    case 'INVALID_IDP_RESPONSE':
      return { status: 401, message: 'Invalid email or password' }
    case 'USER_DISABLED':
      return { status: 403, message: 'Account disabled' }
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return { status: 429, message: 'Too many attempts. Try again later.' }
  }

  // Config / infra codes — these are NOT credential errors. Surfacing them as
  // 401 "Invalid email or password" was the source of recurring debugging
  // dead-ends: the user sees a credentials message and re-tries the password
  // when the actual problem is in `.env` or in the provisioning state. Map
  // them to 503 with diagnostic messages instead so the failure mode is
  // obvious from the response alone.
  switch (code) {
    case 'API_KEY_INVALID':
    case 'API_KEY_NOT_VALID. PLEASE PASS A VALID API KEY.':
      return {
        status: 503,
        message: 'Auth misconfigured: API key invalid. Check VITE_FIREBASE_API_KEY / GIP_FIREBASE_API_KEY in .env.',
      }
    case 'MISSING_TENANT_ID':
      return {
        status: 503,
        message: 'Auth misconfigured: tenantId missing in proxy request. Check GIP_TENANT_ID in .env and that the route forwards it.',
      }
    case 'TENANT_ID_MISMATCH':
      return {
        status: 503,
        message: 'Auth misconfigured: tenant mismatch. API key and tenantId belong to different tenants — re-run provision_auth.',
      }
    case 'CONFIGURATION_NOT_FOUND':
      return {
        status: 503,
        message: 'Auth misconfigured: provider not enabled for this tenant. Enable email/password or Google sign-in in the GIP console.',
      }
  }

  // Unknown code — bucket by ITK HTTP status. 4xx is the user/credential's
  // fault, 5xx is ours/Google's. Returning 502 for an ITK 400 (the previous
  // default) was misleading: the route IS reachable, the server IS healthy,
  // the credentials just aren't valid.
  if (itkStatus >= 400 && itkStatus < 500) {
    return { status: 401, message: 'Authentication failed' }
  }
  return { status: 502, message: 'Authentication service error' }
}

// Sentinel thrown by gipConfig() when env is missing. Caught by handlers to
// return 503 with the actual message instead of an opaque "Internal server
// error" 500.
const GIP_ENV_MISSING_PREFIX = 'GIP env vars missing'

function handleProxyError(err: unknown, res: Response, label: string): void {
  console.error(`[auth] ${label} error:`, err)
  const msg = err instanceof Error ? err.message : String(err)

  if (msg.startsWith(GIP_ENV_MISSING_PREFIX)) {
    res.status(503).json({ error: msg })
    return
  }

  // Prisma error codes that mean "infra setup didn't run / didn't propagate".
  // The previous behaviour returned 500 "Internal server error" — opaque, no
  // recovery path. Surfacing them as 503 with the recovery command turns a
  // multi-hour debug session into a one-line fix.
  //
  // P2021 — table does not exist in the current database. Happens when the
  //         server's DATABASE_URL points at a different SQLite file than the
  //         one db-setup.mjs migrated (cwd-relative vs absolute), or when
  //         predev didn't run at all (server started outside `npm run dev`).
  // P1003 — database file does not exist at the URL path. Happens after a
  //         clean checkout, or when the file was manually deleted.
  // P1001/P1002 — can't reach the DB host (Postgres/MySQL only). Surfaced for
  //         completeness so a downed DB returns 503, not 500.
  if (msg.includes('P2021') || msg.includes('does not exist in the current database')) {
    res.status(503).json({
      error: 'DB schema not initialized. Run `npm run dev` from the project root (predev applies migrations) or `npx prisma migrate deploy`.',
    })
    return
  }
  if (msg.includes('P1003') || msg.includes('Unable to open the database file')) {
    res.status(503).json({
      error: 'DB file missing. Run `npm run dev` to bootstrap, or check DATABASE_URL in .env.',
    })
    return
  }
  if (msg.includes('P1001') || msg.includes('P1002')) {
    res.status(503).json({
      error: 'Database unreachable. Check the DB is running and DATABASE_URL is correct.',
    })
    return
  }

  res.status(500).json({ error: 'Internal server error' })
}

// POST /api/auth/proxy/signup
router.post('/proxy/signup', credentialLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body as { email?: string; password?: string; name?: string }
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' })
      return
    }
    const { apiKey, tenantId } = gipConfig()
    const itk = await fetch(
      `${itkBase()}/accounts:signUp?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          displayName: name || email.split('@')[0],
          tenantId,
          returnSecureToken: true,
        }),
      }
    )
    const data = (await itk.json()) as ITKError & {
      idToken?: string
      refreshToken?: string
      localId?: string
      expiresIn?: string
    }
    if (!itk.ok) {
      const mapped = mapItkError(data.error?.message, itk.status)
      res.status(mapped.status).json({ error: mapped.message })
      return
    }
    res.json({
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      email,
      localId: data.localId,
      expiresIn: data.expiresIn,
    })
  } catch (err) {
    handleProxyError(err, res, 'signup')
  }
})

// POST /api/auth/proxy/signin
router.post('/proxy/signin', credentialLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' })
      return
    }
    const { apiKey, tenantId } = gipConfig()
    const itk = await fetch(
      `${itkBase()}/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          tenantId,
          returnSecureToken: true,
        }),
      }
    )
    const data = (await itk.json()) as ITKError & {
      idToken?: string
      refreshToken?: string
      localId?: string
      expiresIn?: string
    }
    if (!itk.ok) {
      const mapped = mapItkError(data.error?.message, itk.status)
      res.status(mapped.status).json({ error: mapped.message })
      return
    }
    res.json({
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      email,
      localId: data.localId,
      expiresIn: data.expiresIn,
    })
  } catch (err) {
    handleProxyError(err, res, 'signin')
  }
})

// POST /api/auth/proxy/google — exchange Google ID token for Firebase tokens.
// CRITICAL: tenantId is REQUIRED. Removing it returns 400 INVALID_ID_TOKEN
// or a tenant-mismatch error from Identity Toolkit.
router.post('/proxy/google', credentialLimiter, async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body as { idToken?: string }
    if (!idToken) {
      res.status(400).json({ error: 'idToken is required' })
      return
    }
    const { apiKey, tenantId } = gipConfig()
    const itk = await fetch(
      `${itkBase()}/accounts:signInWithIdp?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestUri: 'http://localhost',
          postBody: `id_token=${idToken}&providerId=google.com`,
          returnSecureToken: true,
          returnIdpCredential: true,
          tenantId,
        }),
      }
    )
    const data = (await itk.json()) as ITKError & {
      idToken?: string
      refreshToken?: string
      localId?: string
      email?: string
      displayName?: string
      photoUrl?: string
      expiresIn?: string
    }
    if (!itk.ok) {
      const mapped = mapItkError(data.error?.message, itk.status)
      res.status(mapped.status).json({ error: mapped.message, code: data.error?.message })
      return
    }
    res.json({
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      email: data.email,
      localId: data.localId,
      displayName: data.displayName,
      photoUrl: data.photoUrl,
      expiresIn: data.expiresIn,
    })
  } catch (err) {
    handleProxyError(err, res, 'google')
  }
})

// POST /api/auth/proxy/refresh — refresh Firebase ID token.
router.post('/proxy/refresh', credentialLimiter, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: string }
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' })
      return
    }
    const { apiKey } = gipConfig()
    const itk = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const data = (await itk.json()) as {
      id_token?: string
      refresh_token?: string
      expires_in?: string
    }
    if (!itk.ok) {
      res.status(401).json({ error: 'Token refresh failed' })
      return
    }
    res.json({
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    })
  } catch (err) {
    handleProxyError(err, res, 'refresh')
  }
})

// POST /api/auth/sync — upsert user in DB after a successful auth call.
router.post('/sync', optionalAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { name, avatarUrl } = req.body as { name?: string; avatarUrl?: string }
    const user = await prisma.user.upsert({
      where: { uid: req.user.uid },
      update: {
        email: req.user.email,
        name: name ?? req.user.name ?? null,
        avatarUrl: avatarUrl ?? req.user.picture ?? null,
      },
      create: {
        uid: req.user.uid,
        email: req.user.email,
        name: name ?? req.user.name ?? null,
        avatarUrl: avatarUrl ?? req.user.picture ?? null,
      },
    })
    res.json(user)
  } catch (err) {
    handleProxyError(err, res, 'sync')
  }
})

// GET /api/auth/me — current authenticated user from DB.
router.get('/me', verifyAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { uid: req.user!.uid } })
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    res.json(user)
  } catch (err) {
    handleProxyError(err, res, 'me')
  }
})

export default router
