import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseInbound,
  routeTargets,
  tokenFromSubprotocols,
} from '../src/protocol'
import { COLLAB_SUBPROTOCOL } from '../src/types'

test('tokenFromSubprotocols extracts the token after the marker', () => {
  assert.equal(
    tokenFromSubprotocols(`${COLLAB_SUBPROTOCOL}, my.jwt.token`),
    'my.jwt.token',
  )
})

test('tokenFromSubprotocols rejects missing marker or token', () => {
  assert.equal(tokenFromSubprotocols(null), null)
  assert.equal(tokenFromSubprotocols('something-else, tok'), null)
  assert.equal(tokenFromSubprotocols(COLLAB_SUBPROTOCOL), null)
})

test('parseInbound accepts a well-formed point-to-point signal', () => {
  const msg = parseInbound(JSON.stringify({ type: 'offer', to: 'p2', payload: { sdp: 'x' } }))
  assert.deepEqual(msg, { type: 'offer', to: 'p2', payload: { sdp: 'x' } })
})

test('parseInbound accepts a relay data message (P2P fallback)', () => {
  const msg = parseInbound(JSON.stringify({ type: 'relay', to: 'p2', channel: 'control', payload: '{"t":"chat"}' }))
  assert.deepEqual(msg, { type: 'relay', to: 'p2', channel: 'control', payload: '{"t":"chat"}' })
})

test('parseInbound rejects unknown type, bad relay, missing target, non-JSON', () => {
  assert.equal(parseInbound(JSON.stringify({ type: 'chat', to: 'p2' })), null)
  assert.equal(parseInbound(JSON.stringify({ type: 'offer' })), null)
  assert.equal(parseInbound(JSON.stringify({ type: 'relay', to: 'p2', channel: 'x', payload: 's' })), null)
  assert.equal(parseInbound(JSON.stringify({ type: 'relay', to: 'p2', channel: 'control', payload: 5 })), null)
  assert.equal(parseInbound('not json'), null)
  assert.equal(parseInbound(42), null)
})

test('routeTargets delivers only to the addressed, present, non-self peer', () => {
  const present = ['p1', 'p2', 'p3']
  assert.deepEqual(
    routeTargets({ type: 'ice', to: 'p2', payload: {} }, present, 'p1'),
    ['p2'],
  )
  // Addressed peer absent → nothing delivered.
  assert.deepEqual(
    routeTargets({ type: 'ice', to: 'gone', payload: {} }, present, 'p1'),
    [],
  )
  // Never echoes back to the sender even if self-addressed.
  assert.deepEqual(
    routeTargets({ type: 'ice', to: 'p1', payload: {} }, present, 'p1'),
    [],
  )
})
