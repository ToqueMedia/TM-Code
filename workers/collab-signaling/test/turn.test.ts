import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mintTurnIceServers, normalizeIceServers, TURN_TTL_SECONDS } from '../src/turn'
import type { Env } from '../src/types'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const env = (over: Partial<Env> = {}): Env =>
  ({ TURN_KEY_ID: 'key1', TURN_KEY_API_TOKEN: 'tok1', ...over }) as unknown as Env

test('normalizeIceServers accepts the array shape (generate-ice-servers)', () => {
  const body = {
    iceServers: [
      {
        urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'u',
        credential: 'c',
      },
    ],
  }
  assert.deepEqual(normalizeIceServers(body), body.iceServers)
})

test('normalizeIceServers accepts the singular-object shape (generate)', () => {
  const body = {
    iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' },
  }
  assert.deepEqual(normalizeIceServers(body), [
    { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' },
  ])
})

test('normalizeIceServers coerces a string urls field and drops junk entries', () => {
  const body = {
    iceServers: [
      { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' },
      { username: 'no-urls' },
      'not-an-object',
      { urls: [42] },
    ],
  }
  assert.deepEqual(normalizeIceServers(body), [
    { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' },
  ])
})

test('normalizeIceServers returns null for empty/malformed bodies', () => {
  assert.equal(normalizeIceServers(null), null)
  assert.equal(normalizeIceServers({}), null)
  assert.equal(normalizeIceServers({ iceServers: [] }), null)
  assert.equal(normalizeIceServers({ iceServers: [{ urls: [] }] }), null)
})

test('mintTurnIceServers returns null when the key is not configured', async () => {
  globalThis.fetch = () => {
    throw new Error('must not be called')
  }
  assert.equal(await mintTurnIceServers(env({ TURN_KEY_ID: undefined })), null)
  assert.equal(await mintTurnIceServers(env({ TURN_KEY_API_TOKEN: undefined })), null)
})

test('mintTurnIceServers posts the ttl with the bearer token and normalizes', async () => {
  let captured: { url: string; init: RequestInit } | null = null
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init }
    return new Response(
      JSON.stringify({ iceServers: [{ urls: ['turn:t:3478'], username: 'u', credential: 'c' }] }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  const servers = await mintTurnIceServers(env())
  assert.deepEqual(servers, [{ urls: ['turn:t:3478'], username: 'u', credential: 'c' }])
  assert.ok(captured, 'fetch was called')
  const { url, init } = captured!
  assert.ok(url.includes('/turn/keys/key1/credentials/generate-ice-servers'))
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer tok1')
  assert.deepEqual(JSON.parse(String(init.body)), { ttl: TURN_TTL_SECONDS })
})

test('mintTurnIceServers swallows API errors and transport failures', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof fetch
  assert.equal(await mintTurnIceServers(env()), null)
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  assert.equal(await mintTurnIceServers(env()), null)
})
