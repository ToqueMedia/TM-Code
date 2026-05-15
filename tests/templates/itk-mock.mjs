#!/usr/bin/env node
/**
 * Local Identity Toolkit mock for the e2e test.
 *
 * The real backend's auth.ts hits identitytoolkit.googleapis.com directly
 * with a hardcoded URL — we can't change that without touching the template.
 * Instead, the e2e test wraps the dev server in an /etc/hosts-style override
 * via the NODE_OPTIONS=--dns-result-order trick or, more reliably, by
 * pointing the backend's fetch at a localhost mock through monkey-patching
 * is too invasive.
 *
 * Solution: this mock binds a real local HTTP server, and the backend's
 * route file uses an env-var override (ITK_BASE_URL_OVERRIDE) when set —
 * a pattern dev/test code uses widely. Production and the original e2e
 * (no override) hit Google's real ITK.
 *
 * The mock returns ITK-shaped responses keyed off the request body:
 *   - signInWithIdp + idToken=bogus.token.value → 400 INVALID_ID_TOKEN
 *   - signInWithIdp + missing tenantId         → 400 MISSING_TENANT_ID
 *   - any other shape                            → 400 UNKNOWN_ERROR
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.ITK_MOCK_PORT) || 4499

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (chunk) => (buf += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf))
      } catch {
        resolve({})
      }
    })
  })
}

// Email / idToken triggers for config-error mapping tests. These let the test
// script exercise the backend's mapItkError config branch (API_KEY_INVALID,
// CONFIGURATION_NOT_FOUND, TENANT_ID_MISMATCH) without restarting the server
// with a bad API key. The trigger value is artificial but the upstream ITK
// response shape is identical to what production returns.
function triggerFromEmail(email) {
  if (!email) return null
  if (email === 'error.api-key-invalid@test') return 'API_KEY_INVALID'
  if (email === 'error.config-not-found@test') return 'CONFIGURATION_NOT_FOUND'
  if (email === 'error.tenant-mismatch@test') return 'TENANT_ID_MISMATCH'
  return null
}
function triggerFromIdToken(postBody) {
  if (typeof postBody !== 'string') return null
  if (postBody.includes('id_token=__api_key_invalid__')) return 'API_KEY_INVALID'
  if (postBody.includes('id_token=__config_not_found__')) return 'CONFIGURATION_NOT_FOUND'
  if (postBody.includes('id_token=__tenant_mismatch__')) return 'TENANT_ID_MISMATCH'
  return null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // /v1/accounts:signInWithIdp?key=... — Google sign-in exchange.
  if (req.method === 'POST' && url.pathname === '/v1/accounts:signInWithIdp') {
    const body = await readJson(req)
    if (!body.tenantId) {
      // The bug we explicitly want to surface: the route forgot tenantId.
      send(res, 400, { error: { message: 'MISSING_TENANT_ID', code: 400 } })
      return
    }
    const trigger = triggerFromIdToken(body.postBody)
    if (trigger) {
      send(res, 400, { error: { message: trigger, code: 400 } })
      return
    }
    if (typeof body.postBody === 'string' && body.postBody.includes('id_token=bogus.token.value')) {
      send(res, 400, { error: { message: 'INVALID_ID_TOKEN', code: 400 } })
      return
    }
    // For any other token, simulate success so the test can validate the
    // happy path on demand.
    send(res, 200, {
      idToken: 'mock-id-token',
      refreshToken: 'mock-refresh-token',
      localId: 'mock-uid-123',
      email: 'mock@example.com',
      displayName: 'Mock User',
      photoUrl: 'https://example.com/avatar.png',
      expiresIn: '3600',
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/accounts:signInWithPassword') {
    const body = await readJson(req)
    if (!body.tenantId) {
      send(res, 400, { error: { message: 'MISSING_TENANT_ID', code: 400 } })
      return
    }
    const trigger = triggerFromEmail(body.email)
    if (trigger) {
      send(res, 400, { error: { message: trigger, code: 400 } })
      return
    }
    send(res, 401, { error: { message: 'INVALID_LOGIN_CREDENTIALS', code: 401 } })
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/accounts:signUp') {
    const body = await readJson(req)
    if (!body.tenantId) {
      send(res, 400, { error: { message: 'MISSING_TENANT_ID', code: 400 } })
      return
    }
    const trigger = triggerFromEmail(body.email)
    if (trigger) {
      send(res, 400, { error: { message: trigger, code: 400 } })
      return
    }
    send(res, 200, {
      idToken: 'mock-id-token',
      refreshToken: 'mock-refresh-token',
      localId: 'mock-uid-new',
      email: body.email,
      expiresIn: '3600',
    })
    return
  }

  send(res, 404, { error: { message: 'NOT_FOUND_BY_MOCK' } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[itk-mock] listening on http://127.0.0.1:${PORT}`)
})
