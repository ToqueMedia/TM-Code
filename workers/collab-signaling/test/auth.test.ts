import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyToken } from '../src/auth'
import type { Env } from '../src/types'

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const fakeJwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`

const env = (over: Partial<Env>): Env => ({
  SIGNALING_ROOM: {} as Env['SIGNALING_ROOM'],
  FIREBASE_PROJECT_ID: 'demo-proj',
  ...over,
})

test('test_static mode accepts the configured token only', async () => {
  const e = env({ AUTH_MODE: 'test_static', TEST_USER_TOKEN: 'secret' })
  assert.deepEqual(await verifyToken('secret', e), { userId: 'test-user' })
  await assert.rejects(() => verifyToken('wrong', e))
})

test('emulator mode reads sub from an unsigned token', async () => {
  const e = env({ AUTH_MODE: 'firebase_emulator' })
  const tok = fakeJwt({ sub: 'u-123', exp: Math.floor(Date.now() / 1000) + 3600 })
  assert.deepEqual(await verifyToken(tok, e), { userId: 'u-123' })
})

test('emulator mode rejects an expired token', async () => {
  const e = env({ AUTH_MODE: 'firebase_emulator' })
  const tok = fakeJwt({ sub: 'u-123', exp: Math.floor(Date.now() / 1000) - 10 })
  await assert.rejects(() => verifyToken(tok, e))
})

test('verifyToken rejects an empty or malformed token', async () => {
  const e = env({ AUTH_MODE: 'firebase_emulator' })
  await assert.rejects(() => verifyToken('', e))
  await assert.rejects(() => verifyToken('not-a-jwt', e))
})
