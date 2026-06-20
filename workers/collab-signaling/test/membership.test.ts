import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkMembership, isMemberInDoc } from '../src/membership'
import type { Env } from '../src/types'

const teamDoc = (uids: string[]) => ({
  fields: {
    members: {
      mapValue: {
        fields: Object.fromEntries(uids.map((u) => [u, { mapValue: { fields: {} } }])),
      },
    },
  },
})

test('isMemberInDoc detects membership from the team members map', () => {
  assert.equal(isMemberInDoc(teamDoc(['alice', 'bob']), 'alice'), true)
  assert.equal(isMemberInDoc(teamDoc(['alice', 'bob']), 'carol'), false)
  assert.equal(isMemberInDoc(null, 'alice'), false)
  assert.equal(isMemberInDoc({ fields: {} }, 'alice'), false)
})

function fakeFetcher(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

const baseEnv: Env = {
  SIGNALING_ROOM: {} as Env['SIGNALING_ROOM'],
  FIREBASE_PROJECT_ID: 'demo-proj',
  FIRESTORE_REST_BASE: 'http://127.0.0.1:8080',
}

test('checkMembership returns true when the uid is in the team doc', async () => {
  const ok = await checkMembership('team1', 'alice', 'idtok', baseEnv, fakeFetcher(200, teamDoc(['alice'])))
  assert.equal(ok, true)
})

test('checkMembership fails closed for non-members', async () => {
  const ok = await checkMembership('team1', 'mallory', 'idtok', baseEnv, fakeFetcher(200, teamDoc(['alice'])))
  assert.equal(ok, false)
})

test('checkMembership fails closed on denied read (rules) or missing doc', async () => {
  assert.equal(
    await checkMembership('team1', 'alice', 'idtok', baseEnv, fakeFetcher(403, {})),
    false,
  )
  assert.equal(
    await checkMembership('team1', 'alice', 'idtok', baseEnv, fakeFetcher(404, {})),
    false,
  )
})

test('checkMembership fails closed without a project id', async () => {
  const ok = await checkMembership(
    'team1',
    'alice',
    'idtok',
    { ...baseEnv, FIREBASE_PROJECT_ID: undefined },
    fakeFetcher(200, teamDoc(['alice'])),
  )
  assert.equal(ok, false)
})
