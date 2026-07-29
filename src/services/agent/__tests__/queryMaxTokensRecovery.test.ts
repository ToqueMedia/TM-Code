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

/**
 * Stream que fecha sem NUNCA mandar `finish_reason` — comportamento observado
 * em providers OpenAI-compat do data-plane. `stopReason` fica "", que não bate
 * com "length" nem "max_tokens", portanto a recovery de truncagem não disparava
 * e o run terminava como completo sobre uma resposta cortada.
 */
const NO_FINISH_REASON_TURN = [
  { choices: [{ delta: { content: 'Resposta que o socket cortou a mei' } }] },
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
    // 'incomplete', não 'completed' (2026-07-29). O limite de recoveries
    // impede o loop — isso continua certo — mas a resposta CONTINUA cortada, e
    // reportá-la como completa era mentir a jusante: o agentService marcava a
    // tarefa como concluída e o utilizador lia uma frase a meio sem qualquer
    // aviso. O reason novo é o que faz o agentService acrescentar a nota.
    expect(terminal.reason).toBe('incomplete')
  })

  it('um stream que fecha SEM finish_reason não é um run completo', async () => {
    // Alguns providers OpenAI-compat fecham o socket sem mandar o chunk final.
    // `stopReason` ficava "" — que não é "length", portanto a recovery nunca
    // disparava — e o run terminava como 'completed' sobre texto cortado.
    const create = jest.fn().mockImplementation(() => streamResponse(NO_FINISH_REASON_TURN))

    const terminal = (await drain(
      query(baseParams({ client: makeClient(create) })),
    )) as { reason: string }

    // Tentou retomar (1 inicial + 3 recoveries) e assumiu o corte no fim.
    expect(create).toHaveBeenCalledTimes(4)
    expect(terminal.reason).toBe('incomplete')
  })
})
