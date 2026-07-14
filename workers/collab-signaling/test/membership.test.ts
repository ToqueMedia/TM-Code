import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkMembership, isMemberInDoc } from '../src/membership'
import type { Env } from '../src/types'

const teamDoc = (uids: string[], planTier?: string) => ({
  fields: {
    members: {
      mapValue: {
        fields: Object.fromEntries(uids.map((u) => [u, { mapValue: { fields: {} } }])),
      },
    },
    ...(planTier ? { planTier: { stringValue: planTier } } : {}),
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

test('checkMembership returns member + plan when the uid is in the team doc', async () => {
  const result = await checkMembership(
    'team1', 'alice', 'idtok', baseEnv, fakeFetcher(200, teamDoc(['alice'], 'max')),
  )
  assert.deepEqual(result, { member: true, plan: 'max' })
  // A team doc without a planTier still admits the member (plan null →
  // conservative media policy).
  const bare = await checkMembership(
    'team1', 'alice', 'idtok', baseEnv, fakeFetcher(200, teamDoc(['alice'])),
  )
  assert.deepEqual(bare, { member: true, plan: null })
})

test('checkMembership fails closed for non-members (and never leaks the plan)', async () => {
  const result = await checkMembership(
    'team1', 'mallory', 'idtok', baseEnv, fakeFetcher(200, teamDoc(['alice'], 'max')),
  )
  assert.deepEqual(result, { member: false, plan: null })
})

test('checkMembership fails closed on denied read (rules) or missing doc', async () => {
  assert.deepEqual(
    await checkMembership('team1', 'alice', 'idtok', baseEnv, fakeFetcher(403, {})),
    { member: false, plan: null },
  )
  assert.deepEqual(
    await checkMembership('team1', 'alice', 'idtok', baseEnv, fakeFetcher(404, {})),
    { member: false, plan: null },
  )
})

test('checkMembership fails closed without a project id', async () => {
  const result = await checkMembership(
    'team1',
    'alice',
    'idtok',
    { ...baseEnv, FIREBASE_PROJECT_ID: undefined },
    fakeFetcher(200, teamDoc(['alice'])),
  )
  assert.deepEqual(result, { member: false, plan: null })
})

// ── Production path: control-plane proxy (no FIRESTORE_REST_BASE) ──
// In production the Worker can't read Firestore directly (App Check ENFORCED),
// so checkMembership POSTs to the control-plane, which returns { member, plan }.
const prodEnv: Env = {
  SIGNALING_ROOM: {} as Env['SIGNALING_ROOM'],
  FIREBASE_PROJECT_ID: 'demo-proj',
  CONTROL_PLANE_URL: 'https://api.example.test',
}

test('checkMembership (proxy) returns member + plan from the control-plane', async () => {
  const result = await checkMembership(
    'team1', 'alice', 'idtok', prodEnv, fakeFetcher(200, { member: true, plan: 'pro' }),
  )
  assert.deepEqual(result, { member: true, plan: 'pro' })
})

test('checkMembership (proxy) tolerates an OLD control-plane without plan', async () => {
  const result = await checkMembership(
    'team1', 'alice', 'idtok', prodEnv, fakeFetcher(200, { member: true }),
  )
  assert.deepEqual(result, { member: true, plan: null })
})

test('checkMembership (proxy) fails closed when the control-plane says not a member', async () => {
  const result = await checkMembership(
    'team1', 'alice', 'idtok', prodEnv, fakeFetcher(200, { member: false, plan: 'max' }),
  )
  assert.deepEqual(result, { member: false, plan: null })
})

test('checkMembership (proxy) fails closed on a non-2xx from the control-plane', async () => {
  assert.deepEqual(
    await checkMembership('team1', 'alice', 'idtok', prodEnv, fakeFetcher(500, {})),
    { member: false, plan: null },
  )
  assert.deepEqual(
    await checkMembership('team1', 'alice', 'idtok', prodEnv, fakeFetcher(403, {})),
    { member: false, plan: null },
  )
})

test('checkMembership (proxy) fails closed without a control-plane url', async () => {
  const result = await checkMembership(
    'team1',
    'alice',
    'idtok',
    { ...prodEnv, CONTROL_PLANE_URL: undefined },
    fakeFetcher(200, { member: true }),
  )
  assert.deepEqual(result, { member: false, plan: null })
})
