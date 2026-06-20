import {
  buildChatControl,
  parseControlMessage,
  parseStoredChat,
  type ChatMessage,
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
})
