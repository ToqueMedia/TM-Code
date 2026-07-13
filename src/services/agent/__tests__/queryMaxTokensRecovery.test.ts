/**
 * Recovery de truncagem por output-cap (2026-07-13).
 *
 * BUG HISTÓRICO: a recovery comparava stopReason só com "max_tokens"
 * (vocabulário Anthropic), mas os providers OpenAI-compat emitem
 * finish_reason "length" — nunca disparava e respostas truncadas terminavam
 * a run como completas. Agora: (a) aceita ambos, (b) escala o cap dos
 * pedidos seguintes (porte claude-vaz), (c) injeta continuação "resume
 * exactly where it stopped".
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

function baseParams(overrides: Partial<QueryParams> = {}): QueryParams {
  return {
    messages: [],
    systemPrompt: 'system',
    client: makeClient(jest.fn()),
    model: 'test-model',
    tools: [],
    executeTool: jest.fn(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

const TRUNCATED_TURN = [
  { choices: [{ delta: { content: 'Resposta longa cortada a mei' } }] },
  { choices: [{ delta: {}, finish_reason: 'length' }] },
]

const STOP_TURN = [
  { choices: [{ delta: { content: 'o. E aqui termina completa.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]

async function drain(generator: AsyncGenerator<QueryStreamEvent, unknown>) {
  let res = await generator.next()
  while (!res.done) res = await generator.next()
  return res.value
}

describe('query — output-cap truncation recovery', () => {
  it('finish_reason "length" (OpenAI-compat) injeta continuação em vez de terminar', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(TRUNCATED_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const terminal = (await drain(
      query(baseParams({ client: makeClient(create) })),
    )) as { reason: string }

    expect(terminal.reason).toBe('completed')
    expect(create).toHaveBeenCalledTimes(2)

    // O 2º pedido leva a mensagem de continuação.
    const secondMessages = create.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>
    const hasResume = secondMessages.some(
      (m) => m.role === 'user' && JSON.stringify(m.content ?? '').includes('Resume EXACTLY where it stopped'),
    )
    expect(hasResume).toBe(true)
  })

  it('escala max_tokens nos pedidos seguintes à truncagem', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(TRUNCATED_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    await drain(query(baseParams({ client: makeClient(create) })))

    const firstMax = create.mock.calls[0][0].max_tokens as number
    const secondMax = create.mock.calls[1][0].max_tokens as number
    expect(secondMax).toBeGreaterThan(firstMax)
    expect(secondMax).toBe(Math.min(65_536, firstMax * 2))
  })

  it('respeita o limite de recoveries (não entra em loop com truncagem persistente)', async () => {
    // 5 truncagens seguidas: 1 inicial + 3 recoveries (limite) = 4 pedidos; o 4º termina.
    const create = jest.fn().mockImplementation(() => streamResponse(TRUNCATED_TURN))

    const terminal = (await drain(
      query(baseParams({ client: makeClient(create) })),
    )) as { reason: string }

    expect(create).toHaveBeenCalledTimes(4)
    expect(terminal.reason).toBe('completed')
  })
})
