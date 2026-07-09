import { test } from 'node:test'
import assert from 'node:assert/strict'
import { policyForPlan } from '../src/mediaPolicy'
import { membershipFromDoc } from '../src/membership'

test('policyForPlan maps max (any casing) to the max tier', () => {
  assert.equal(policyForPlan('max').maxCallMinutes, null)
  assert.equal(policyForPlan('MAX').maxCallParticipants, 8)
  assert.equal(policyForPlan(' Max ').screenMaxHeight, 1440)
  assert.equal(policyForPlan('max').screenMaxBitrateKbps, 8000)
})

test('policyForPlan is conservative for pro/unknown/null', () => {
  for (const plan of ['pro', 'PRO', 'enterprise?', '', null, undefined]) {
    const policy = policyForPlan(plan)
    assert.equal(policy.maxCallParticipants, 4)
    assert.equal(policy.maxCallMinutes, 120)
    assert.equal(policy.maxScreenWatchers, 3)
    assert.equal(policy.screenMaxHeight, 1080)
    assert.equal(policy.screenMaxFrameRate, 12)
    assert.equal(policy.screenMaxBitrateKbps, 3000)
  }
})

test('membershipFromDoc returns member + plan from the team doc', () => {
  const doc = {
    fields: {
      members: { mapValue: { fields: { u1: {} } } },
      planTier: { stringValue: 'max' },
    },
  }
  assert.deepEqual(membershipFromDoc(doc, 'u1'), { member: true, plan: 'max' })
  // Non-member never leaks the plan.
  assert.deepEqual(membershipFromDoc(doc, 'u2'), { member: false, plan: null })
  // Member of a team without a planTier → null plan (conservative policy).
  const bare = { fields: { members: { mapValue: { fields: { u1: {} } } } } }
  assert.deepEqual(membershipFromDoc(bare, 'u1'), { member: true, plan: null })
})
