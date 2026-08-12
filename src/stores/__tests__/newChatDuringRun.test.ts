import { useChatStore } from '../chatStore'

// Stub permissivo: o chatStore chama vários métodos do serviço no arranque e
// persegui-los um a um só adiciona ruído — o que este teste observa é o STORE.
jest.mock('../../services/agent/sessionService', () => {
  let n = 0
  const target: Record<string, unknown> = {
    createSession: jest.fn(async (projectPath: string) => ({
      id: `sess-new-${n++}`,
      projectPath,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  }
  const sessionService = new Proxy(target, {
    get(t, prop: string) {
      if (!(prop in t)) t[prop] = jest.fn()
      return t[prop]
    },
  })
  return { sessionService, default: sessionService }
})

/**
 * "Novo Chat" com um run vivo (2026-08-10).
 *
 * O botão bloqueava em `isStreaming`, uma flag GLOBAL do store. Com o pivot
 * multi-projecto isso significava: basta o projecto A estar a correr para o
 * "Novo Chat" ficar morto no projecto B — exactamente o passo de pôr o segundo
 * projecto a trabalhar.
 *
 * O store nunca precisou dessa guarda: `createNewSession` preserva a sessão em
 * streaming de propósito ("wiping them would orphan a mid-flight main stream").
 * Estes testes fixam essa garantia, que é o que torna seguro tirar o bloqueio
 * da UI.
 */
describe('createNewSession com um run vivo', () => {
  it('preserva a sessão em streaming e o estado do run', async () => {
    const live = 'sess-live'
    useChatStore.setState({
      sessions: new Map([[live, {
        id: live,
        projectPath: '/proj/a',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      } as never]]),
      activeSessionId: live,
      streamingSessionId: live,
      streamingMessageId: 'msg-1',
      isStreaming: true,
    })

    const newId = await useChatStore.getState().createNewSession('/proj/b')
    const s = useChatStore.getState()

    // A sessão do run continua em memória — sem isto o stream ficava órfão.
    expect(s.sessions.has(live)).toBe(true)
    // A vista mudou para o chat novo.
    expect(s.activeSessionId).toBe(newId)
    expect(s.activeSessionId).not.toBe(live)
    // O run continua preso à SUA sessão, não à vista.
    expect(s.streamingSessionId).toBe(live)
    expect(s.streamingMessageId).toBe('msg-1')
  })

  it('cria mesmo com isStreaming a true — a flag é global, não do projecto', async () => {
    useChatStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      streamingSessionId: null,
      streamingMessageId: null,
      isStreaming: true,
    })

    const id = await useChatStore.getState().createNewSession('/proj/b')

    expect(typeof id).toBe('string')
    expect(useChatStore.getState().activeSessionId).toBe(id)
  })
})
