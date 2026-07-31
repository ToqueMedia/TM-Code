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
  { choices: [{ delta: { content: 'Done.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
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
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
]

async function drain(generator: AsyncGenerator<QueryStreamEvent, unknown>) {
  let res = await generator.next()
  while (!res.done) res = await generator.next()
  return res.value
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('query — read-only policy and write-action telemetry', () => {
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

  it('populates write-action telemetry in onRequestUsage and QueryTerminal', async () => {
    const usageEntries: unknown[] = []
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(EDIT_TURN)) // turn 1: calls edit_file
      .mockImplementationOnce(() => streamResponse(STOP_TURN)) // turn 2: stops

    const terminal = await drain(
      query(
        baseParams({
          client: makeClient(create),
          executeTool: jest.fn().mockResolvedValue({ content: 'edited', isError: false }),
          onRequestUsage: (entry) => { usageEntries.push(entry) },
          executionPhase: 'original_task',
        }),
      ),
    ) as { runHasEdited?: boolean; firstWriteTurn?: number; writeActionCount?: number; originalTaskWriteActionCount?: number }

    // Turn 1: onRequestUsage fires BEFORE tool execution — no edits yet.
    expect(usageEntries[0]).toMatchObject({ runHasEdited: false, writeActionCount: 0 })
    // Turn 2: the edit ran in turn 1 → cumulative values reflect it.
    expect(usageEntries[1]).toMatchObject({ runHasEdited: true, firstWriteTurn: 1, writeActionCount: 1, originalTaskWriteActionCount: 1 })
    // Terminal: final values.
    expect(terminal).toMatchObject({ reason: 'completed', runHasEdited: true, firstWriteTurn: 1, writeActionCount: 1, originalTaskWriteActionCount: 1 })
  })
})
