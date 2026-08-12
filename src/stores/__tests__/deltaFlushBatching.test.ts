import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered } from '../chatStore'

/**
 * Um render por flush, não um por entrada da fila (2026-08-10).
 *
 * O flush de 50ms agrupava as escrituras no modelo mas replicava a fila
 * chamando uma função de delta por entrada — e cada uma fazia o seu próprio
 * `set(streamingVersion + 1)`. Uma sequência intercalada
 * (reasoning → text → reasoning → text) produzia uma passagem de render por
 * alternância. Com o GLM-5.2 a intercalar muito (47.271 tokens de thinking,
 * 30% do payload numa sessão medida), a main thread saturava e escrever no
 * composer durante um run ficava a arrancar.
 */
describe('flush de deltas — um só render', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('uma sequência intercalada faz UMA passagem de streamingVersion', () => {
    const before = useChatStore.getState().streamingVersion

    appendTextDeltaBuffered('a')
    appendReasoningDeltaBuffered('r1')
    appendTextDeltaBuffered('b')
    appendReasoningDeltaBuffered('r2')
    appendTextDeltaBuffered('c')

    // Nada renderizou ainda — a fila só drena no timer.
    expect(useChatStore.getState().streamingVersion).toBe(before)

    jest.advanceTimersByTime(60)

    // 5 entradas na fila, UM incremento. Antes eram 5.
    expect(useChatStore.getState().streamingVersion).toBe(before + 1)
  })

  it('deltas contíguos do mesmo tipo continuam a coalescer', () => {
    const before = useChatStore.getState().streamingVersion
    appendTextDeltaBuffered('x')
    appendTextDeltaBuffered('y')
    appendTextDeltaBuffered('z')
    jest.advanceTimersByTime(60)
    expect(useChatStore.getState().streamingVersion).toBe(before + 1)
  })

  it('uma fila vazia não força render', () => {
    const before = useChatStore.getState().streamingVersion
    jest.advanceTimersByTime(200)
    expect(useChatStore.getState().streamingVersion).toBe(before)
  })
})
