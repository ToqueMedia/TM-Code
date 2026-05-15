// JWT verification middleware.
//
// Dev (NODE_ENV !== 'production'): `decodeJwt` without signature verification.
// The proxy is the only path that mints tokens, so signature checks add latency
// without changing the trust model.
//
// Prod (NODE_ENV === 'production'): full signature verification against the
// GIP/Firebase secure-token JWKS. The skill mandates this — without it, a
// tampered or forged token from outside this proxy still decodes cleanly.
import type { Request, Response, NextFunction } from 'express'
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose'

export interface AuthUser {
  uid: string
  email: string
  name?: string
  picture?: string
  tenant?: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

// The ONLY correct JWKS URL for Firebase/GIP ID tokens. Other tempting URLs
// (`oauth2/v3/certs`, `service_accounts/v1/metadata/...`) are for different
// Google APIs and will fail signature verification — see auth-proxy skill.
const JWKS = IS_PRODUCTION
  ? createRemoteJWKSet(
      new URL(
        'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
      ),
    )
  : null

function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  return header.slice(7)
}

type Payload = Record<string, unknown> & {
  sub?: string
  email?: string
  name?: string
  picture?: string
  firebase?: { tenant?: string }
}

function payloadToUser(payload: Payload, expectedTenant: string | undefined): AuthUser | null {
  if (!payload.sub || !payload.email) return null
  if (expectedTenant && payload.firebase?.tenant !== expectedTenant) return null
  return {
    uid: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    tenant: payload.firebase?.tenant,
  }
}

async function verifyAndExtract(token: string): Promise<AuthUser | null> {
  const expectedTenant = process.env.GIP_TENANT_ID
  if (IS_PRODUCTION && JWKS) {
    const projectId = process.env.GCP_PROJECT_ID
    if (!projectId) {
      console.error('[auth] GCP_PROJECT_ID missing in production — cannot verify token')
      return null
    }
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
      })
      return payloadToUser(payload as Payload, expectedTenant)
    } catch (err) {
      // Signature / issuer / audience / expiry failures land here. Log once
      // for diagnosability — the response stays generic 401 to avoid leaking
      // which check failed to an attacker.
      console.warn('[auth] jwtVerify failed:', err instanceof Error ? err.message : err)
      return null
    }
  }
  try {
    return payloadToUser(decodeJwt(token) as Payload, expectedTenant)
  } catch {
    return null
  }
}

export async function verifyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const user = await verifyAndExtract(token)
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }
  req.user = user
  next()
}

// For routes that work both authenticated and anonymously (e.g. /sync after
// signup, where the user row doesn't exist yet but the token is fresh).
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req)
  if (token) {
    const user = await verifyAndExtract(token)
    if (user) req.user = user
  }
  next()
}
