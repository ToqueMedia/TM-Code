import { query, type QueryParams, type QueryStreamEvent } from '../query'

function makeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

function makeHeartbeatOnlyStream(onReturn: jest.Mock): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await new Promise(resolve => setTimeout(resolve, 2))
          return {
            done: false,
            value: { choices: [{ delta: { role: 'assistant' } }] },
          }
        },
        async return() {
          onReturn()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

function makeClient(create: jest.Mock) {
  return {
    chat: {
      completions: {
        create,
      },
    },
  } as unknown as QueryParams['client']
}

function makeStreamingCreate(chunks: unknown[]) {
  return jest.fn(() => ({
    withResponse: async () => ({
      data: makeStream(chunks),
      response: { headers: new Headers() },
    }),
  }))
}


function baseParams(overrides: Partial<QueryParams> = {}): QueryParams {
  const client = makeClient(makeStreamingCreate([
    { choices: [{ delta: { content: 'done' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]))

  return {
    messages: [],
    systemPrompt: 'system',
    client,
    model: 'test-model',
    tools: [],
    executeTool: jest.fn(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function nextEvent(generator: AsyncGenerator<QueryStreamEvent, unknown>): Promise<QueryStreamEvent> {
  const next = await generator.next()
  if (next.done) throw new Error('Expected stream event, got terminal result')
  return next.value
}

describe('query retry handling', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('refreshes the SDK client and retries when the Worker rejects an expired auth token', async () => {
    const expired = Object.assign(new Error('401 Invalid token'), {
      status: 401,
      error: { error: 'Invalid token' },
    })
    const firstCreate = jest.fn(() => {
      throw expired
    })
    const refreshedCreate = makeStreamingCreate([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const refreshClient = jest.fn().mockResolvedValue(makeClient(refreshedCreate))

    const generator = query(baseParams({
      client: makeClient(firstCreate),
      refreshClient,
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      httpStatus: 401,
    })
    expect(await nextEvent(generator)).toEqual({ type: 'text_delta', text: 'ok' })

    const terminal = await generator.next()
    expect(terminal.done).toBe(false)
    expect(terminal.value).toMatchObject({ type: 'message_stop', stopReason: 'stop' })
    expect(refreshClient).toHaveBeenCalledTimes(1)
    expect(firstCreate).toHaveBeenCalledTimes(1)
    expect(refreshedCreate).toHaveBeenCalledTimes(1)
  })

  it('fails immediately when an expired auth token cannot be refreshed', async () => {
    const expired = Object.assign(new Error('401 Invalid token'), {
      status: 401,
      error: { error: 'Invalid token' },
    })
    const create = jest.fn(() => {
      throw expired
    })
    const refreshClient = jest.fn().mockResolvedValue(null)

    const generator = query(baseParams({
      client: makeClient(create),
      refreshClient,
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      httpStatus: 401,
    })
    expect(await nextEvent(generator)).toEqual({
      type: 'error',
      message: 'Authentication expired. Please sign in again.',
    })

    const terminal = await generator.next()
    expect(terminal.done).toBe(true)
    expect(terminal.value).toMatchObject({ reason: 'error' })
    expect(refreshClient).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('fails immediately when the refreshed client still receives platform auth 401', async () => {
    const expired = Object.assign(new Error('401 Invalid token'), {
      status: 401,
      error: { error: 'Invalid token' },
    })
    const firstCreate = jest.fn(() => {
      throw expired
    })
    const refreshedCreate = jest.fn(() => {
      throw expired
    })
    const refreshClient = jest.fn().mockResolvedValue(makeClient(refreshedCreate))

    const generator = query(baseParams({
      client: makeClient(firstCreate),
      refreshClient,
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      httpStatus: 401,
    })
    expect(await nextEvent(generator)).toEqual({
      type: 'error',
      message: 'Authentication expired. Please sign in again.',
    })

    const terminal = await generator.next()
    expect(terminal.done).toBe(true)
    expect(terminal.value).toMatchObject({ reason: 'error' })
    expect(refreshClient).toHaveBeenCalledTimes(1)
    expect(firstCreate).toHaveBeenCalledTimes(1)
    expect(refreshedCreate).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the request after prompt_too_long overflow recovery (forced snip)', async () => {
    // NOTA (auditoria 2026-07-28): este teste chamava stageCollapse() antes —
    // mas o staging esteve sempre inerte (_enabled=false), portanto a
    // recuperação que ele SEMPRE validou foi a do snip mecânico. O módulo
    // collapse/ foi apagado; a asserção não mudou porque o comportamento
    // real nunca dependeu dele.
    const promptTooLong = new Error('prompt_too_long')
    const create = jest
      .fn()
      .mockImplementationOnce(() => {
        throw promptTooLong
      })
      .mockImplementationOnce(() => ({
        withResponse: async () => ({
          data: makeStream([
            { choices: [{ delta: { content: 'recovered' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]),
          response: { headers: new Headers() },
        }),
      }))

    const messages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: null,
    }))

    const generator = query(baseParams({
      client: makeClient(create),
      messages,
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toEqual({ type: 'text_delta', text: 'recovered' })

    expect(create).toHaveBeenCalledTimes(2)
    const firstMessages = create.mock.calls[0][0].messages
    const secondMessages = create.mock.calls[1][0].messages
    expect(secondMessages.length).toBeLessThan(firstMessages.length)
  })

  it('captures usage-only streaming chunks with empty choices', async () => {
    const onUsage = jest.fn()
    const onRequestUsage = jest.fn()
    const create = makeStreamingCreate([
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1234,
          completion_tokens: 56,
          total_tokens: 1290,
          prompt_tokens_details: { cached_tokens: 789 },
        },
      },
    ])

    const generator = query(baseParams({
      client: makeClient(create),
      onUsage,
      onRequestUsage,
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toEqual({ type: 'text_delta', text: 'done' })

    const stop = await nextEvent(generator)
    expect(stop).toMatchObject({
      type: 'message_stop',
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 56,
      },
    })

    expect(onUsage).toHaveBeenCalledWith(1234, 56)
    expect(onRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 1234,
      outputTokens: 56,
      usageAvailable: true,
      cacheReadInputTokens: 789,
    }))
  })


  it('retries provider credential/configuration errors 3 times with 30s backoff before failing', async () => {
    jest.useFakeTimers()

    const create = makeStreamingCreate([
      {
        error: {
          type: 'upstream_http_error',
          status: 401,
          message: '{"error":"invalid token"}',
          provider: 'provider',
          model: 'model',
        },
      },
    ])

    const generator = query(baseParams({ client: makeClient(create) }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })

    expect(await nextEvent(generator)).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      attempt: 1,
      maxAttempts: 3,
      retryInMs: 30000,
    })

    const secondAttempt = nextEvent(generator)
    jest.advanceTimersByTime(30000)
    await Promise.resolve()
    expect(await secondAttempt).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      attempt: 2,
      maxAttempts: 3,
      retryInMs: 30000,
    })

    const thirdAttempt = nextEvent(generator)
    jest.advanceTimersByTime(30000)
    await Promise.resolve()
    expect(await thirdAttempt).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      attempt: 3,
      maxAttempts: 3,
      retryInMs: 30000,
    })

    const finalError = nextEvent(generator)
    jest.advanceTimersByTime(30000)
    await Promise.resolve()
    expect(await finalError).toMatchObject({
      type: 'error',
      message: expect.stringContaining('Provider error (401)'),
    })

    const terminal = await generator.next()
    expect(terminal.done).toBe(true)
    expect(terminal.value).toMatchObject({ reason: 'error' })
    expect(create).toHaveBeenCalledTimes(4)
  })

  it('retries a stalled stream (withheld) and only surfaces the error after the limit', async () => {
    // Contrato novo (withheld errors, 2026-07-13): um stream que nunca produz
    // progresso útil é um corte TRANSITÓRIO — o watchdog aborta o pedido e o
    // loop repete (nada foi emitido, retry é seguro), com status visível.
    // O erro só chega ao user depois de STREAM_CUT_RECOVERY_LIMIT retries.
    const streamReturn = jest.fn()
    const create = jest.fn((_body, _opts) => ({
      withResponse: async () => ({
        data: makeHeartbeatOnlyStream(streamReturn),
        response: { headers: new Headers() },
      }),
    }))

    const generator = query(baseParams({
      client: makeClient(create),
      streamSemanticIdleTimeoutMs: 15,
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      attempt: 1,
    })
    expect(await nextEvent(generator)).toMatchObject({
      type: 'agent_status',
      phase: 'retrying',
      attempt: 2,
    })
    expect(await nextEvent(generator)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('did not produce model output'),
    })

    // Cada tentativa abortou o SEU pedido via watchdog (1 inicial + 2 retries).
    expect(create).toHaveBeenCalledTimes(3)
    const requestSignal = create.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(requestSignal.aborted).toBe(true)
    expect(streamReturn).toHaveBeenCalled()

    const terminal = await generator.next()
    expect(terminal.done).toBe(true)
    expect(terminal.value).toMatchObject({ reason: 'error' })
  })
})
