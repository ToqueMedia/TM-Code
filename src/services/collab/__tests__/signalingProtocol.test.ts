import {
  buildSignalingUrl,
  COLLAB_SUBPROTOCOL,
  parseServerMessage,
  sanitizeIceServers,
  sanitizeMediaPolicy,
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

    it('passes the welcome iceServers blob through untouched', () => {
      const welcome = {
        type: 'welcome',
        selfId: 'p1',
        peers: [],
        iceServers: [{ urls: ['turn:t:3478'], username: 'u', credential: 'c' }],
      }
      expect(parseServerMessage(JSON.stringify(welcome))).toEqual(welcome)
    })
  })

  describe('sanitizeIceServers', () => {
    it('accepts valid entries and coerces a string urls field', () => {
      expect(
        sanitizeIceServers([
          { urls: ['turn:t:3478?transport=udp', 'turns:t:5349'], username: 'u', credential: 'c' },
          { urls: 'stun:s:3478' },
        ]),
      ).toEqual([
        { urls: ['turn:t:3478?transport=udp', 'turns:t:5349'], username: 'u', credential: 'c' },
        { urls: ['stun:s:3478'] },
      ])
    })

    it('drops junk entries and junk url items, keeping the good ones', () => {
      expect(
        sanitizeIceServers([
          'nope',
          { username: 'no-urls' },
          { urls: [42, 'turn:ok:3478'], username: 'u', credential: 'c' },
        ]),
      ).toEqual([{ urls: ['turn:ok:3478'], username: 'u', credential: 'c' }])
    })

    it('returns null for absent, non-array, or fully-junk input', () => {
      expect(sanitizeIceServers(undefined)).toBeNull()
      expect(sanitizeIceServers({ urls: ['turn:t'] })).toBeNull() // object, not array
      expect(sanitizeIceServers([])).toBeNull()
      expect(sanitizeIceServers([{ urls: [] }, null])).toBeNull()
    })

    it('drops non-string username/credential instead of passing them through', () => {
      expect(sanitizeIceServers([{ urls: 'turn:t:3478', username: 42, credential: null }])).toEqual([
        { urls: ['turn:t:3478'] },
      ])
    })
  })

  describe('sanitizeMediaPolicy', () => {
    const pro = {
      maxCallParticipants: 4,
      maxCallMinutes: 120,
      maxScreenWatchers: 3,
      screenMaxHeight: 720,
      screenMaxFrameRate: 10,
    }

    it('accepts a valid policy and floors fractional numbers', () => {
      expect(sanitizeMediaPolicy(pro)).toEqual(pro)
      expect(sanitizeMediaPolicy({ ...pro, maxCallParticipants: 4.9 })).toEqual({
        ...pro,
        maxCallParticipants: 4,
      })
    })

    it('accepts null maxCallMinutes as "unlimited"', () => {
      expect(sanitizeMediaPolicy({ ...pro, maxCallMinutes: null })).toEqual({
        ...pro,
        maxCallMinutes: null,
      })
    })

    it('rejects absent, malformed, or non-positive fields', () => {
      expect(sanitizeMediaPolicy(undefined)).toBeNull()
      expect(sanitizeMediaPolicy('policy')).toBeNull()
      expect(sanitizeMediaPolicy({})).toBeNull()
      expect(sanitizeMediaPolicy({ ...pro, maxCallParticipants: 0 })).toBeNull()
      expect(sanitizeMediaPolicy({ ...pro, screenMaxHeight: '720' })).toBeNull()
      expect(sanitizeMediaPolicy({ ...pro, maxCallMinutes: -5 })).toBeNull()
      expect(sanitizeMediaPolicy({ ...pro, screenMaxFrameRate: NaN })).toBeNull()
    })
  })
})
