import {
  buildChatControl,
  buildVoiceStateControl,
  dedupeChatById,
  parseControlMessage,
  parseStoredChat,
  type ChatMessage,
  type VoiceState,
} from '../collabChat'

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  uid: 'u1',
  name: 'Ada',
  text: 'hello team',
  ts: 1_700_000_000_000,
  ...over,
})

describe('collabChat', () => {
  it('round-trips a chat control envelope', () => {
    const env = buildChatControl(msg())
    expect(env).toEqual({ t: 'chat', msg: msg() })
    expect(parseControlMessage(env)).toEqual({ t: 'chat', msg: msg() })
  })

  it('rejects malformed or unknown control messages', () => {
    expect(parseControlMessage(null)).toBeNull()
    expect(parseControlMessage({ t: 'chat' })).toBeNull()
    expect(parseControlMessage({ t: 'chat', msg: { id: 'x' } })).toBeNull()
    expect(parseControlMessage({ t: 'presence', msg: msg() })).toBeNull()
    expect(parseControlMessage({ t: 'chat', msg: { ...msg(), ts: 'nope' } })).toBeNull()
  })

  it('parses a typing presence envelope and rejects bad ones', () => {
    expect(parseControlMessage({ t: 'typing', uid: 'u1', name: 'Ada', typing: true })).toEqual({
      t: 'typing',
      uid: 'u1',
      name: 'Ada',
      typing: true,
    })
    expect(parseControlMessage({ t: 'typing', uid: 'u1', name: 'Ada', typing: false })).toEqual({
      t: 'typing',
      uid: 'u1',
      name: 'Ada',
      typing: false,
    })
    // `typing` must be a real boolean, not truthy/missing.
    expect(parseControlMessage({ t: 'typing', uid: 'u1', name: 'Ada' })).toBeNull()
    expect(parseControlMessage({ t: 'typing', uid: 'u1', name: 'Ada', typing: 'yes' })).toBeNull()
    expect(parseControlMessage({ t: 'typing', uid: 1, name: 'Ada', typing: true })).toBeNull()
  })

  it('parses a persisted JSONL line, dropping bad lines', () => {
    expect(parseStoredChat(JSON.stringify(msg()))).toEqual(msg())
    expect(parseStoredChat('not json')).toBeNull()
    expect(parseStoredChat(JSON.stringify({ id: 'only' }))).toBeNull()
  })

  it('dedupeChatById keeps the first occurrence per id, preserving order', () => {
    const a1 = msg({ id: 'a', ts: 1 })
    const b = msg({ id: 'b', ts: 2 })
    const a2 = msg({ id: 'a', ts: 3 })
    const c = msg({ id: 'c', ts: 4 })
    expect(dedupeChatById([a1, b, a2, c, b])).toEqual([a1, b, c])
    expect(dedupeChatById([])).toEqual([])
  })

  it('round-trips a voice-state envelope and rejects bad ones', () => {
    const state: VoiceState = { uid: 'u1', name: 'Ada', inCall: true, muted: false }
    const env = buildVoiceStateControl(state)
    expect(env).toEqual({ t: 'voice-state', state })
    expect(parseControlMessage(env)).toEqual({ t: 'voice-state', state })
    // Every field is required and strictly typed.
    expect(parseControlMessage({ t: 'voice-state' })).toBeNull()
    expect(parseControlMessage({ t: 'voice-state', state: { uid: 'u1', name: 'Ada' } })).toBeNull()
    expect(
      parseControlMessage({ t: 'voice-state', state: { ...state, inCall: 'yes' } }),
    ).toBeNull()
    expect(parseControlMessage({ t: 'voice-state', state: { ...state, muted: 1 } })).toBeNull()
    // Extra unknown fields are dropped, not echoed through.
    expect(
      parseControlMessage({ t: 'voice-state', state: { ...state, extra: 'x' } }),
    ).toEqual({ t: 'voice-state', state })
  })

  it('parses a voice-speaking envelope and rejects bad ones', () => {
    expect(parseControlMessage({ t: 'voice-speaking', uid: 'u1', speaking: true })).toEqual({
      t: 'voice-speaking',
      uid: 'u1',
      speaking: true,
    })
    expect(parseControlMessage({ t: 'voice-speaking', uid: 'u1', speaking: false })).toEqual({
      t: 'voice-speaking',
      uid: 'u1',
      speaking: false,
    })
    expect(parseControlMessage({ t: 'voice-speaking', uid: 'u1' })).toBeNull()
    expect(parseControlMessage({ t: 'voice-speaking', uid: 'u1', speaking: 'yes' })).toBeNull()
    expect(parseControlMessage({ t: 'voice-speaking', speaking: true })).toBeNull()
  })
})
