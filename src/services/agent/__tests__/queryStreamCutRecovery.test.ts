/**
 * Withheld transient stream-cut recovery (2026-07-13, porte claude-vaz):
 * cortes transitórios (rede/5xx/stall) não superficializam erro enquanto
 * houver via de recuperação — pré-output repete o pedido; pós-output
 * preserva o parcial, fecha tool calls órfãs com resultados sintéticos e
 * retoma num turno novo. Cancelamento do user e 4xx tipados nunca entram.
 */
import { query, type QueryParams, type QueryStreamEvent } from '../query'

function makeStream(chunks: unknown[], failAfter?: number): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      // failAfter = N corta o stream ANTES do chunk N (N === length ⇒ corta
      // depois do último chunk emitido).
      for (let i = 0; i <= chunks.length; i++) {
        if (failAfter !== undefined && i === failAfter) {
          throw new Error('fetch failed: network connection was terminated')
        }
        if (i < chunks.length) yield chunks[i]
      }
    },
  }
}

function makeClient(create: jest.Mock) {
  return { chat: { completions: { create } } } as unknown as QueryParams['client']
}

function streamResponse(chunks: unknown[], failAfter?: number) {
  return {
    withResponse: async () => ({
      data: makeStream(chunks, failAfter),
      response: { headers: new Headers() },
    }),
  }
}

const STOP_TURN = [
  { choices: [{ delta: { content: 'resposta completa.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]

async function drainCollecting(generator: AsyncGenerator<QueryStreamEvent, unknown>) {
  const events: QueryStreamEvent[] = []
  let res = await generator.next()
  while (!res.done) {
    events.push(res.value)
    res = await generator.next()
  }
  return { events, terminal: res.value as { reason: string } }
}

function baseParams(overrides: Partial<QueryParams>): QueryParams {
  return {
    messages: [],
    systemPrompt: 'system',
    client: makeClient(jest.fn()),
    model: 'test-model',
    tools: [],
    executeTool: jest.fn(async () => ({ content: 'ok', isError: false })),
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('query — withheld transient stream-cut recovery', () => {
  it('pré-output: corte de rede repete o mesmo pedido em vez de dar erro', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse([], 0)) // corta antes de qualquer chunk
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const { events, terminal } = await drainCollecting(
      query(baseParams({ client: makeClient(create) })),
    )

    expect(terminal.reason).toBe('completed')
    expect(create).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'agent_status' && /Retrying/.test((e as any).message))).toBe(true)
  })

  it('pós-output: preserva o texto parcial e retoma num turno novo', async () => {
    const partialChunks = [
      { choices: [{ delta: { content: 'Início da resposta que foi cor' } }] },
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(partialChunks, 1)) // corta após texto
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const { events, terminal } = await drainCollecting(
      query(baseParams({ client: makeClient(create) })),
    )

    expect(terminal.reason).toBe('completed')
    expect(events.some((e) => e.type === 'error')).toBe(false)

    // O 2º pedido leva o parcial como turno assistant + instrução de retoma.
    const secondMessages = create.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>
    const serialized = JSON.stringify(secondMessages)
    expect(serialized).toContain('Início da resposta que foi cor')
    expect(serialized).toContain('Resume EXACTLY where it stopped')
  })

  it('pós-output com tool call órfã: fecha-a com tool_result sintético', async () => {
    const partialChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/a.ts"}' } },
              ],
            },
          },
        ],
      },
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(partialChunks, 1))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const { events, terminal } = await drainCollecting(
      query(baseParams({ client: makeClient(create) })),
    )

    expect(terminal.reason).toBe('completed')
    const synthetic = events.find(
      (e) => e.type === 'tool_result' && (e as any).toolUseId === 'call_0',
    ) as any
    expect(synthetic).toBeDefined()
    expect(synthetic.isError).toBe(true)
    expect(synthetic.content).toContain('interrupted')

    // O histórico do 2º pedido tem o par tool_call/tool_result completo
    // (sem órfãos para o filterIncompleteToolCalls remover).
    const serialized = JSON.stringify(create.mock.calls[1][0].messages)
    expect(serialized).toContain('call_0')
    expect(serialized).toContain('Re-issue')
  })

  it('esgota o limite e só então superficializa o erro', async () => {
    // 3 cortes seguidos: 1 inicial + 2 recoveries (limite) → o 3º erro surge.
    const create = jest.fn().mockImplementation(() => streamResponse([], 0))

    const { events, terminal } = await drainCollecting(
      query(baseParams({ client: makeClient(create) })),
    )

    expect(create).toHaveBeenCalledTimes(3)
    expect(terminal.reason).toBe('error')
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('cancelamento do user nunca é tratado como corte transitório', async () => {
    const abort = new AbortController()
    const create = jest.fn().mockImplementationOnce(() => ({
      withResponse: async () => {
        abort.abort()
        throw new Error('The operation was aborted')
      },
    }))

    const { terminal } = await drainCollecting(
      query(baseParams({ client: makeClient(create), signal: abort.signal })),
    )

    // Sem retry: um único pedido.
    expect(create).toHaveBeenCalledTimes(1)
    expect(terminal.reason).not.toBe('completed')
  })
})
