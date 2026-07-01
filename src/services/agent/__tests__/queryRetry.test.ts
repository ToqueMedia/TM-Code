import { query, type QueryParams, type QueryStreamEvent } from '../query'
import { ToolsetSelector, REQUEST_TOOLS_NAME, BUGFIX_BASE } from '../toolsetSelector'
import {
  SEARCH_FILES, READ_FILE, READ_LARGE_RESULT, EDIT_FILE, GLOB,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
  WRITE_FILE, START_DEV_SERVER, PROVISION_AUTH,
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
} from '../toolNames'
import {
  resetContextCollapse,
  setContextCollapseEnabled,
  stageCollapse,
} from '../collapse/contextCollapse'

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

function makeTool(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: `tool ${name}`, parameters: { type: 'object' as const, properties: {} } },
  }
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
    resetContextCollapse()
    setContextCollapseEnabled(false)
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

  it('rebuilds the request after prompt_too_long overflow recovery', async () => {
    stageCollapse(0, 10, 'older turns summary')

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

  it('selects tools from human-authored text, not synthetic @mention/tool_result content', async () => {
    const names = [
      READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
      SEARCH_FILES, READ_FILE, READ_LARGE_RESULT, EDIT_FILE, GLOB,
      EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
      WRITE_FILE, START_DEV_SERVER, PROVISION_AUTH,
    ]
    const create = makeStreamingCreate([
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])

    const generator = query(baseParams({
      client: makeClient(create),
      tools: names.map(makeTool),
      toolsetSelector: new ToolsetSelector(names),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'fix a typo in this file' },
            {
              type: 'tool_result',
              toolCallId: 'mention-read',
              content: 'deploy auth create file dev server database',
            },
          ],
        },
      ],
    }))

    expect(await nextEvent(generator)).toEqual({ type: 'message_start' })
    expect(await nextEvent(generator)).toEqual({ type: 'text_delta', text: 'done' })

    const sentToolNames = (create.mock.calls as any)[0][0].tools.map((t: any) => t.function.name)
    for (const core of BUGFIX_BASE) {
      expect(sentToolNames).toContain(core)
    }
    expect(sentToolNames).toContain(REQUEST_TOOLS_NAME)
    expect(sentToolNames).not.toContain(WRITE_FILE)
    expect(sentToolNames).not.toContain(START_DEV_SERVER)
    expect(sentToolNames).not.toContain(PROVISION_AUTH)
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

  it('aborts a live stream that never produces useful model progress', async () => {
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
      type: 'error',
      message: expect.stringContaining('did not produce model output'),
    })

    const requestSignal = create.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(requestSignal.aborted).toBe(true)
    expect(streamReturn).toHaveBeenCalled()

    const terminal = await generator.next()
    expect(terminal.done).toBe(true)
    expect(terminal.value).toMatchObject({ reason: 'error' })
  })
})
