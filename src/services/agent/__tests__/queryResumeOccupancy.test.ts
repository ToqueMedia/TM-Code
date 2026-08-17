/**
 * Stop + mensagem de retoma ("continue") é o mesmo prato.
 *
 * "continue" NÃO é um comando: é uma mensagem a dizer ao agente para
 * seguir onde parou. O query() seguinte é outra invocação, mas a
 * ocupação tem de nascer do último usage REAL — não de um medidor vazio
 * e não do campo 405k da estimativa.
 */
import { query, type QueryParams, type QueryStreamEvent } from '../query'

function makeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeClient(create: jest.Mock) {
  return {
    chat: { completions: { create } },
  } as unknown as QueryParams['client']
}

function streamResponse(chunks: unknown[]) {
  return {
    withResponse: async () => ({
      data: makeStream(chunks),
      response: { headers: new Headers() },
    }),
  }
}

const STOP_TURN = [
  { choices: [{ delta: { content: 'A seguir de onde parei.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
]

function createMock(streamChunks: unknown[] = STOP_TURN) {
  return jest.fn((body: { stream?: boolean }) => {
    if (body?.stream) return streamResponse(streamChunks)
    return { choices: [{ message: { content: 'Summary of the conversation so far.' } }] }
  })
}

function baseParams(overrides: Partial<QueryParams> = {}): QueryParams {
  return {
    messages: [
      { role: 'user', content: 'trabalha nisto' },
      { role: 'assistant', content: 'a meio' },
      { role: 'user', content: 'continue' },
    ],
    systemPrompt: 'system',
    client: makeClient(createMock()),
    model: 'test-model',
    tools: [],
    executeTool: jest.fn(),
    signal: new AbortController().signal,
    getContextLimits: () => ({ contextWindow: 262_144, maxOutputTokens: 16_384 }),
    ...overrides,
  }
}

async function collect(generator: AsyncGenerator<QueryStreamEvent, unknown>) {
  const events: QueryStreamEvent[] = []
  let res = await generator.next()
  while (!res.done) {
    events.push(res.value)
    res = await generator.next()
  }
  return { events, terminal: res.value }
}

describe('query — follow-up "continue" após Stop', () => {
  it('não compacta quando o prato real está abaixo do limiar (caso 14-49-57)', async () => {
    const { events } = await collect(query(baseParams({
      initialRealOccupancyTokens: 145_608 + 1_039,
      initialRealOccupancyMessageCount: 2,
    })))
    expect(events.some((e) => e.type === 'compact_start')).toBe(false)
  })

  it('compacta quando o mesmo prato já passou o limiar', async () => {
    const { events } = await collect(query(baseParams({
      getContextLimits: () => ({ contextWindow: 200_000, maxOutputTokens: 16_384 }),
      initialRealOccupancyTokens: 190_000,
      initialRealOccupancyMessageCount: 2,
    })))
    expect(events.some((e) => e.type === 'compact_start')).toBe(true)
    expect(events.some((e) => e.type === 'compact_end')).toBe(true)
  })

  it('sem semente, uma estimativa pequena do histórico não compacta sozinha', async () => {
    const { events } = await collect(query(baseParams({
      getContextLimits: () => ({ contextWindow: 200_000, maxOutputTokens: 16_384 }),
    })))
    expect(events.some((e) => e.type === 'compact_start')).toBe(false)
  })
})
