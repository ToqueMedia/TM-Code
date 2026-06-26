import { query, type QueryParams, type QueryStreamEvent } from '../query'

// ── Harness (mirrors queryRetry.test.ts) ──
function makeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
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

const TOOL_TURN = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'foo', arguments: '{}' },
            },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]

const STOP_TURN = [
  { choices: [{ delta: { content: 'done' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]

async function drain(generator: AsyncGenerator<QueryStreamEvent, unknown>) {
  let res = await generator.next()
  while (!res.done) res = await generator.next()
  return res.value
}

function steeredInto(create: jest.Mock, callIndex: number, needle: string): boolean {
  const messages = create.mock.calls[callIndex]?.[0]?.messages ?? []
  return messages.some(
    (m: { role?: string; content?: unknown }) =>
      m.role === 'user' && JSON.stringify(m.content ?? '').includes(needle),
  )
}

describe('query — queued-message steering (claude-vaz parity)', () => {
  it('injects a message queued mid-run into the NEXT turn, not at session end', async () => {
    // Turn 1 calls a tool; turn 2 stops. The developer "queued" a message
    // while turn 1 was streaming — collectQueuedSteering surfaces it once.
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(TOOL_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const collectQueuedSteering = jest
      .fn<Promise<string | null>, []>()
      .mockResolvedValueOnce('please also add tests')
      .mockResolvedValue(null)

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executeTool: jest.fn().mockResolvedValue({ content: 'tool output', isError: false }),
          collectQueuedSteering,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(collectQueuedSteering).toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(2)
    // The steered text rode the SECOND request (the turn after it was queued)…
    expect(steeredInto(create, 1, 'please also add tests')).toBe(true)
    // …and was NOT smuggled into the first request.
    expect(steeredInto(create, 0, 'please also add tests')).toBe(false)
  })

  it('keeps the run alive when a message is queued just as the model would stop', async () => {
    // Turn 1 would stop immediately (no tool call). A queued message turns the
    // would-be terminal into another turn instead of ending the run.
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(STOP_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const collectQueuedSteering = jest
      .fn<Promise<string | null>, []>()
      .mockResolvedValueOnce('one more thing')
      .mockResolvedValue(null)

    const terminal = await drain(
      query(baseParams({ client: makeClient(create), collectQueuedSteering })),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(steeredInto(create, 1, 'one more thing')).toBe(true)
  })

  it('preserves multimodal queued steering content for the next turn', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(TOOL_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    const collectQueuedSteering = jest
      .fn<ReturnType<NonNullable<QueryParams['collectQueuedSteering']>>, []>()
      .mockResolvedValueOnce([
        { type: 'text', text: 'inspect this screenshot' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ])
      .mockResolvedValue(null)

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executeTool: jest.fn().mockResolvedValue({ content: 'tool output', isError: false }),
          collectQueuedSteering,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    const messages = create.mock.calls[1]?.[0]?.messages ?? []
    const steeredUser = messages.find(
      (m: { role?: string; content?: unknown }) =>
        m.role === 'user' && JSON.stringify(m.content ?? '').includes('inspect this screenshot'),
    )
    expect(steeredUser?.content).toEqual([
      { type: 'text', text: 'inspect this screenshot' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })

  it('does not add a turn when nothing is queued', async () => {
    const create = jest.fn().mockImplementationOnce(() => streamResponse(STOP_TURN))
    const collectQueuedSteering = jest.fn<Promise<string | null>, []>().mockResolvedValue(null)

    const terminal = await drain(
      query(baseParams({ client: makeClient(create), collectQueuedSteering })),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
