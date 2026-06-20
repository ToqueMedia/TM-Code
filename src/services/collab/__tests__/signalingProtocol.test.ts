import {
  buildSignalingUrl,
  COLLAB_SUBPROTOCOL,
  parseServerMessage,
  shouldInitiate,
  signalingSubprotocols,
} from '../signalingProtocol'

describe('signalingProtocol', () => {
  describe('buildSignalingUrl', () => {
    it('appends the room path and url-encodes the name; trims trailing slash', () => {
      expect(buildSignalingUrl('ws://localhost:8789/', 'team-1', 'Ada L')).toBe(
        'ws://localhost:8789/v1/collab/team-1?name=Ada%20L',
      )
    })

    it('encodes a room id with special characters', () => {
      expect(buildSignalingUrl('wss://host', 'a/b', '')).toBe('wss://host/v1/collab/a%2Fb')
    })

    it('never puts the token in the URL (token goes in the subprotocol)', () => {
      const url = buildSignalingUrl('wss://host', 'team', 'name')
      expect(url).not.toContain('token')
    })
  })

  describe('signalingSubprotocols', () => {
    it('carries the marker then the token', () => {
      expect(signalingSubprotocols('jwt.here')).toEqual([COLLAB_SUBPROTOCOL, 'jwt.here'])
    })
  })

  describe('shouldInitiate', () => {
    it('lets exactly one side of a pair initiate (smaller id)', () => {
      expect(shouldInitiate('aaa', 'bbb')).toBe(true)
      expect(shouldInitiate('bbb', 'aaa')).toBe(false)
      // Antisymmetry — never both, never neither.
      expect(shouldInitiate('x', 'y')).not.toBe(shouldInitiate('y', 'x'))
    })
  })

  describe('parseServerMessage', () => {
    it('accepts a typed server message', () => {
      expect(parseServerMessage(JSON.stringify({ type: 'peer-leave', peerId: 'p1' }))).toEqual({
        type: 'peer-leave',
        peerId: 'p1',
      })
    })

    it('rejects non-string, non-JSON, and typeless input', () => {
      expect(parseServerMessage(123)).toBeNull()
      expect(parseServerMessage('{bad')).toBeNull()
      expect(parseServerMessage(JSON.stringify({ noType: 1 }))).toBeNull()
    })
  })
})
