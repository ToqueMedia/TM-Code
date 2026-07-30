import { query, type QueryParams, type QueryStreamEvent } from '../query'

// ── Harness (mirrors querySteering.test.ts) ──────────────────────────────

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

const STOP_TURN = [
  { choices: [{ delta: { content: 'No próximo turno, aplicarei a correção.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]

const EDIT_TURN = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'edit_file', arguments: '{"file_path":"/t.ts","old_string":"a","new_string":"b"}' },
            },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
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


// ── Tests ────────────────────────────────────────────────────────────────

describe('query — "stopped without editing" guardrail', () => {
  it('injects a steering turn when a mutable original_task stops without any edit', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(STOP_TURN)) // turn 1: stops with text
      .mockImplementationOnce(() => streamResponse(STOP_TURN)) // turn 2: stops again

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(2)
    // The steering message should ride the second request. Procura a frase do
    // guard, não 'request_tools': o ramo que mandava activar edit_file saiu com
    // o ToolsetSelector (2026-07-30) — sem selecção dinâmica a ferramenta já
    // está sempre no toolset, e a recuperação é sempre "aplica a alteração".
    expect(steeredInto(create, 1, 'have not applied any edit yet')).toBe(true)
  })

  it('does NOT fire when hard readOnly enforcement is true', async () => {
    const create = jest.fn().mockImplementationOnce(() => streamResponse(STOP_TURN))

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          readOnlyRun: true,
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('blocks direct write tool calls when hard readOnly enforcement is true', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(EDIT_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))
    const executeTool = jest.fn().mockResolvedValue({ content: 'edited', isError: false })

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          readOnlyRun: true,
          executeTool,
        }),
      ),
    ) as { runHasEdited?: boolean; writeActionCount?: number }

    expect(executeTool).not.toHaveBeenCalled()
    expect(terminal).toMatchObject({ reason: 'completed', runHasEdited: false, writeActionCount: 0 })
  })

  it('does NOT fire when mutableTask is false', async () => {
    const create = jest.fn().mockImplementationOnce(() => streamResponse(STOP_TURN))

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executionPhase: 'original_task',
          mutableTask: false,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('fires for mutable frontend_ui tasks, not only bugfix_local', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(STOP_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    await drain(
      query(
        baseParams({
          client: makeClient(create),
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    )

    expect(create).toHaveBeenCalledTimes(2)
    expect(steeredInto(create, 1, 'edit_file available')).toBe(true)
  })

  it('does NOT fire when an edit was already applied', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(EDIT_TURN)) // turn 1: calls edit_file
      .mockImplementationOnce(() => streamResponse(STOP_TURN)) // turn 2: stops (but already edited)

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executeTool: jest.fn().mockResolvedValue({ content: 'edited', isError: false }),
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(2)
    // No steering should appear in the second request.
    expect(steeredInto(create, 1, 'request_tools')).toBe(false)
  })

  it('fires only once — a second stop-without-edit terminates the run', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(STOP_TURN)) // turn 1: stops → steering
      .mockImplementationOnce(() => streamResponse(STOP_TURN)) // turn 2: stops again → no more recovery

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    )

    expect(terminal).toMatchObject({ reason: 'completed' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('tells the model to use edit_file directly when it is already active', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(STOP_TURN))
      .mockImplementationOnce(() => streamResponse(STOP_TURN))

    await drain(
      query(
        baseParams({
          client: makeClient(create),
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    )

    expect(steeredInto(create, 1, 'edit_file available')).toBe(true)
  })

  it('populates guardrail telemetry in onRequestUsage and QueryTerminal', async () => {
    const usageEntries: unknown[] = []
    const STOP_WITH_USAGE = [
      { choices: [{ delta: { content: 'No próximo turno, aplicarei a correção.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]
    const EDIT_WITH_USAGE = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'edit_file', arguments: '{"file_path":"/t.ts","old_string":"a","new_string":"b"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(STOP_WITH_USAGE)) // turn 1: stops → guardrail fires
      .mockImplementationOnce(() => streamResponse(EDIT_WITH_USAGE)) // turn 2: model recovers, calls edit_file
      .mockImplementationOnce(() => streamResponse(STOP_WITH_USAGE)) // turn 3: model stops (already edited)

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executeTool: jest.fn().mockResolvedValue({ content: 'edited', isError: false }),
          onRequestUsage: (entry) => { usageEntries.push(entry) },
          executionPhase: 'original_task',
          mutableTask: true,
        }),
      ),
    ) as { completionGuardDecision?: string; runHasEdited?: boolean; noEditRecoveryCount?: number; firstWriteTurn?: number; writeActionCount?: number }

    // Turn 1: no edits yet, guard hasn't fired (fires after onRequestUsage).
    expect(usageEntries[0]).toMatchObject({ runHasEdited: false, noEditRecoveryCount: 0, noEditGuardTriggered: false })
    // Turn 2: guard fired in turn 1 → noEditGuardTriggered=true. onRequestUsage
    // fires BEFORE tool execution, so runHasEdited is still false (the edit
    // hasn't run yet at this point in the request cycle).
    expect(usageEntries[1]).toMatchObject({ runHasEdited: false, noEditRecoveryCount: 1, noEditGuardTriggered: true })
    // Turn 3: edit ran in turn 2 → cumulative values now reflect it.
    expect(usageEntries[2]).toMatchObject({ runHasEdited: true, noEditRecoveryCount: 1, noEditGuardTriggered: false, firstWriteTurn: 2, writeActionCount: 1, originalTaskWriteActionCount: 1 })
    // Terminal: final decision.
    expect(terminal).toMatchObject({ completionGuardDecision: 'recovered_then_completed', runHasEdited: true, noEditRecoveryCount: 1, firstWriteTurn: 2, writeActionCount: 1 })
  })
})
