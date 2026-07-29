/**
 * Execução de tools em streaming (2026-07-13, porte scoped do claude-vaz
 * StreamingToolExecutor): tools read-only (isStreamSafeTool) começam a
 * executar quando os args completam DURANTE o SSE (index novo ⇒ anteriores
 * completos). Os yields de tool_result ficam pós-stream, em ordem — só a
 * execução antecipa.
 */
import { query, type QueryParams, type QueryStreamEvent } from '../query'

// ── Harness com log de interleaving ─────────────────────────────────────
// `events` regista a ordem real: 'chunk:N' quando o stream emite, 'exec:id'
// quando executeTool é invocado. É isto que prova o overlap: exec do tool 0
// tem de aparecer ANTES do último chunk.

function loggedStream(chunks: unknown[], events: string[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i++) {
        events.push(`chunk:${i}`)
        yield chunks[i]
      }
    },
  }
}

function makeClient(create: jest.Mock) {
  return { chat: { completions: { create } } } as unknown as QueryParams['client']
}

function streamResponse(chunks: unknown[], events: string[]) {
  return {
    withResponse: async () => ({
      data: loggedStream(chunks, events),
      response: { headers: new Headers() },
    }),
  }
}

function toolCallDelta(index: number, id: string, name: string, args: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }],
        },
      },
    ],
  }
}

const FINISH_TOOLS = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
const STOP_TURN = [
  { choices: [{ delta: { content: 'done' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]

async function drainCollecting(
  generator: AsyncGenerator<QueryStreamEvent, unknown>,
): Promise<{ events: QueryStreamEvent[]; terminal: unknown }> {
  const out: QueryStreamEvent[] = []
  let res = await generator.next()
  while (!res.done) {
    out.push(res.value)
    res = await generator.next()
  }
  return { events: out, terminal: res.value }
}

function makeExecuteTool(events: string[]) {
  return jest.fn(async (_name: string, _input: Record<string, unknown>, id: string) => {
    events.push(`exec:${id}`)
    return { content: `result-${id}`, isError: false }
  })
}

function baseParams(overrides: Partial<QueryParams>): QueryParams {
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

describe('query — streaming tool execution', () => {
  it('read-only tool começa a executar durante o stream (antes do último chunk)', async () => {
    const events: string[] = []
    const chunks = [
      toolCallDelta(0, 'call_0', 'read_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(1, 'call_1', 'read_file', '{"file_path":"/b.ts"}'),
      FINISH_TOOLS,
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(chunks, events))
      .mockImplementationOnce(() => streamResponse(STOP_TURN, events))

    const executeTool = makeExecuteTool(events)
    const { events: streamEvents } = await drainCollecting(
      query(baseParams({
        client: makeClient(create),
        executeTool,
        isStreamSafeTool: () => true,
      })),
    )

    // call_0 executou entre o chunk 1 (index novo) e o chunk 2 (finish).
    const exec0 = events.indexOf('exec:call_0')
    const lastChunkOfFirstStream = events.indexOf('chunk:2')
    expect(exec0).toBeGreaterThan(-1)
    expect(exec0).toBeLessThan(lastChunkOfFirstStream)

    // Sem re-execução: cada call executa exatamente uma vez.
    expect(executeTool).toHaveBeenCalledTimes(2)

    // Contrato de eventos intacto: tool_results pós-stream, em ordem.
    const results = streamEvents.filter((e) => e.type === 'tool_result') as Array<{
      type: 'tool_result'; toolUseId: string; content: string
    }>
    expect(results.map((r) => r.toolUseId)).toEqual(['call_0', 'call_1'])
    expect(results[0].content).toBe('result-call_0')
  })

  it('regra de prefixo: um tool não-safe bloqueia pre-dispatch de tudo depois dele', async () => {
    const events: string[] = []
    const chunks = [
      toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
      toolCallDelta(1, 'call_1', 'read_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(2, 'call_2', 'read_file', '{"file_path":"/b.ts"}'),
      FINISH_TOOLS,
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(chunks, events))
      .mockImplementationOnce(() => streamResponse(STOP_TURN, events))

    const executeTool = makeExecuteTool(events)
    await drainCollecting(
      query(baseParams({
        client: makeClient(create),
        executeTool,
        // edit_file não é stream-safe; reads são.
        isStreamSafeTool: (name) => name !== 'edit_file',
      })),
    )

    // NENHUMA execução aconteceu antes do fim do primeiro stream: o edit no
    // index 0 quebra o prefixo (um read nunca observa estado pré-edit).
    const lastChunkOfFirstStream = events.indexOf('chunk:3')
    for (const id of ['call_0', 'call_1', 'call_2']) {
      expect(events.indexOf(`exec:${id}`)).toBeGreaterThan(lastChunkOfFirstStream)
    }
    expect(executeTool).toHaveBeenCalledTimes(3)
  })

  it('args que chegam após o dispatch invalidam o pre-dispatch (re-executa com args completos)', async () => {
    const events: string[] = []
    const chunks = [
      toolCallDelta(0, 'call_0', 'read_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(1, 'call_1', 'read_file', '{"file_path":"/b.ts"}'),
      // Interleaving: mais args para o index 0 DEPOIS do index 1 abrir.
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' ' } }] } }] },
      FINISH_TOOLS,
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(chunks, events))
      .mockImplementationOnce(() => streamResponse(STOP_TURN, events))

    const executeTool = makeExecuteTool(events)
    const { events: streamEvents } = await drainCollecting(
      query(baseParams({
        client: makeClient(create),
        executeTool,
        isStreamSafeTool: () => true,
      })),
    )

    // call_0 executou 2x: pre-dispatch (args truncados) + serial (args finais).
    const call0Execs = events.filter((e) => e === 'exec:call_0').length
    expect(call0Execs).toBe(2)

    // O resultado entregue ao modelo é o da RE-execução (args completos).
    const results = streamEvents.filter((e) => e.type === 'tool_result')
    expect(results.length).toBe(2)
  })

  // ── Fecho do stream: o resto do prefixo arranca EM PARALELO ──────────────
  // O pre-dispatch a meio do SSE só cobre calls com um índice POSTERIOR a
  // seguir, portanto a última call de cada ronda — e todo o turn de chamada
  // única — corria serial (auditoria 2026-07-28: 3 web_fetch independentes
  // custavam 3x a latência).

  it('a ÚLTIMA call da ronda arranca antes de a primeira resolver (paralelo, não serial)', async () => {
    const events: string[] = []
    const invoked: string[] = []
    let call1StartedWhileCall0Pending = false

    // call_0 segura-se enquanto espera ver call_1 arrancar. Em execução
    // serial isso nunca acontece — call_1 só começaria depois de call_0
    // devolver — e a flag fica false.
    const executeTool = jest.fn(async (_name: string, _input: Record<string, unknown>, id: string) => {
      invoked.push(id)
      if (id === 'call_0') {
        for (let i = 0; i < 100 && !invoked.includes('call_1'); i++) {
          if (invoked.includes('call_1')) break
          await new Promise((r) => setTimeout(r, 1))
        }
        call1StartedWhileCall0Pending = invoked.includes('call_1')
      }
      return { content: `result-${id}`, isError: false }
    })

    const chunks = [
      toolCallDelta(0, 'call_0', 'read_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(1, 'call_1', 'read_file', '{"file_path":"/b.ts"}'),
      FINISH_TOOLS,
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(chunks, events))
      .mockImplementationOnce(() => streamResponse(STOP_TURN, events))

    const { events: streamEvents } = await drainCollecting(
      query(baseParams({
        client: makeClient(create),
        executeTool,
        isStreamSafeTool: () => true,
      })),
    )

    expect(call1StartedWhileCall0Pending).toBe(true)
    // Sem execuções a mais e com a ordem dos resultados intacta.
    expect(executeTool).toHaveBeenCalledTimes(2)
    const results = streamEvents.filter((e) => e.type === 'tool_result') as Array<{
      type: 'tool_result'; toolUseId: string
    }>
    expect(results.map((r) => r.toolUseId)).toEqual(['call_0', 'call_1'])
  })

  it('a regra de prefixo continua a valer no fecho: nada arranca depois de um tool não-safe', async () => {
    const events: string[] = []
    const chunks = [
      toolCallDelta(0, 'call_0', 'read_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(1, 'call_1', 'edit_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(2, 'call_2', 'read_file', '{"file_path":"/a.ts"}'),
      FINISH_TOOLS,
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(chunks, events))
      .mockImplementationOnce(() => streamResponse(STOP_TURN, events))

    // O read DEPOIS do edit tem de observar o ficheiro JÁ editado, portanto
    // não pode arrancar em paralelo com ele.
    const order: string[] = []
    const executeTool = jest.fn(async (_n: string, _i: Record<string, unknown>, id: string) => {
      order.push(`start:${id}`)
      await new Promise((r) => setTimeout(r, 1))
      order.push(`end:${id}`)
      return { content: `result-${id}`, isError: false }
    })

    await drainCollecting(
      query(baseParams({
        client: makeClient(create),
        executeTool,
        isStreamSafeTool: (name) => name !== 'edit_file',
      })),
    )

    expect(order.indexOf('start:call_2')).toBeGreaterThan(order.indexOf('end:call_1'))
  })

  it('sem predicado (isStreamSafeTool ausente) nada pre-despacha — comportamento clássico', async () => {
    const events: string[] = []
    const chunks = [
      toolCallDelta(0, 'call_0', 'read_file', '{"file_path":"/a.ts"}'),
      toolCallDelta(1, 'call_1', 'read_file', '{"file_path":"/b.ts"}'),
      FINISH_TOOLS,
    ]
    const create = jest
      .fn()
      .mockImplementationOnce(() => streamResponse(chunks, events))
      .mockImplementationOnce(() => streamResponse(STOP_TURN, events))

    const executeTool = makeExecuteTool(events)
    await drainCollecting(
      query(baseParams({ client: makeClient(create), executeTool })),
    )

    const lastChunkOfFirstStream = events.indexOf('chunk:2')
    expect(events.indexOf('exec:call_0')).toBeGreaterThan(lastChunkOfFirstStream)
    expect(executeTool).toHaveBeenCalledTimes(2)
  })
})
