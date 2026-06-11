import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { clearAccessTokenCache, resolveFirestoreAuthHeaders } from '../src/googleAuth'
import type { Env } from '../src/types'

/**
 * Valida o caminho service-account ponta-a-ponta com uma chave RSA REAL
 * gerada no teste: export PKCS8 → PEM (como o secret no Cloudflare), import,
 * assinatura do JWT RS256, troca OAuth2 mockada, e verificação criptográfica
 * da assinatura com a chave pública. É o mesmo código que corre em produção
 * com os secrets FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.
 */

beforeEach(() => {
  clearAccessTokenCache()
})

async function generateSaKeyPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n')
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  }
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

test('SA path: mints an RS256 assertion, exchanges it, and uses the access token', async () => {
  const { pem, publicKey } = await generateSaKeyPem()
  const exchanges: Array<{ assertion: string }> = []
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      assert.equal(String(input), 'https://oauth2.googleapis.com/token')
      const params = new URLSearchParams(String(init?.body))
      exchanges.push({ assertion: params.get('assertion') ?? '' })
      return Response.json({ access_token: 'sa-access-token', expires_in: 3600 })
    },
  }
  const env: Env = {
    FIREBASE_CLIENT_EMAIL: 'worker@maiplayer-ac56d.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: pem,
  }

  const headers = await resolveFirestoreAuthHeaders(env, 'user-id-token', fetcher)

  // O header final usa o token da SA, NÃO o ID token do utilizador.
  assert.equal(headers.authorization, 'Bearer sa-access-token')

  // O assertion enviado à Google é um JWT RS256 válido assinado pela chave.
  assert.equal(exchanges.length, 1)
  const [headerB64, payloadB64, sigB64] = exchanges[0].assertion.split('.')
  assert.deepEqual(decodeJwtPart(headerB64), { alg: 'RS256', typ: 'JWT' })
  const payload = decodeJwtPart(payloadB64)
  assert.equal(payload.iss, 'worker@maiplayer-ac56d.iam.gserviceaccount.com')
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token')
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/datastore')

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    Buffer.from(sigB64, 'base64url'),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  )
  assert.equal(verified, true)
})

test('SA path: token is cached across calls within its lifetime', async () => {
  const { pem } = await generateSaKeyPem()
  let exchanges = 0
  const fetcher = {
    async fetch() {
      exchanges += 1
      return Response.json({ access_token: 'sa-access-token', expires_in: 3600 })
    },
  }
  const env: Env = { FIREBASE_CLIENT_EMAIL: 'sa@test.iam', FIREBASE_PRIVATE_KEY: pem }

  await resolveFirestoreAuthHeaders(env, 't', fetcher)
  await resolveFirestoreAuthHeaders(env, 't', fetcher)

  assert.equal(exchanges, 1)
})

test('SA path: PEM with literal \\n escapes (dashboard paste) still imports', async () => {
  const { pem } = await generateSaKeyPem()
  const escaped = pem.replace(/\n/g, '\\n')
  const fetcher = {
    async fetch() {
      return Response.json({ access_token: 'sa-access-token', expires_in: 3600 })
    },
  }
  const env: Env = { FIREBASE_CLIENT_EMAIL: 'sa@test.iam', FIREBASE_PRIVATE_KEY: escaped }

  const headers = await resolveFirestoreAuthHeaders(env, 't', fetcher)
  assert.equal(headers.authorization, 'Bearer sa-access-token')
})

test('without SA secrets, falls back to the user ID token', async () => {
  const fetcher = {
    async fetch(): Promise<Response> {
      throw new Error('must not call OAuth without SA credentials')
    },
  }
  const headers = await resolveFirestoreAuthHeaders({}, 'user-id-token', fetcher)
  assert.equal(headers.authorization, 'Bearer user-id-token')
})
