/**
 * Lote de writes num turno (plano iron-valley-widgeon, Parte 1.4): ao chegar
 * ao primeiro write de uma run CONSECUTIVA de writes, o dispatcher despacha a
 * run inteira — os diffs aparecem todos de uma vez em vez de pingados. Writes
 * ao MESMO caminho encadeiam na aprovação do anterior (lost update), um
 * non-write quebra o grupo, caminho não extraível serializa tudo, e o lote
 * fecha em QUALQUER saída do loop (endWriteBatch no finally).
 */
import { query, type QueryParams, type QueryStreamEvent } from '../query'
import { activeWriteBatchIds, isInActiveWriteBatch } from '../writeBatch'

// ── Harness (mesmo padrão de queryStreamingToolExec.test.ts) ─────────────

function loggedStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

function makeClient(create: jest.Mock) {
  return { chat: { completions: { create } } } as unknown as QueryParams['client']
}

function streamResponse(chunks: unknown[]) {
  return {
    withResponse: async () => ({
      data: loggedStream(chunks),
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

const isWriteTool = (name: string) =>
  name === 'write_file' || name === 'edit_file' || name === 'create_file'

function baseParams(overrides: Partial<QueryParams>): QueryParams {
  return {
    messages: [],
    systemPrompt: 'system',
    client: makeClient(jest.fn()),
    model: 'test-model',
    tools: [],
    executeTool: jest.fn(),
    signal: new AbortController().signal,
    isWriteTool,
    ...overrides,
  }
}

function twoTurnClient(firstTurnChunks: unknown[]) {
  return makeClient(
    jest
      .fn()
      .mockImplementationOnce(() => streamResponse(firstTurnChunks))
      .mockImplementationOnce(() => streamResponse(STOP_TURN)),
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** executeTool que regista start/end e segura `holdId` até `untilId` arrancar
 *  (ou ~100ms). Prova/refuta paralelismo sem depender de timing absoluto. */
function makeProbeExecutor(order: string[], holdId?: string, untilId?: string) {
  return jest.fn(async (_name: string, _input: Record<string, unknown>, id: string) => {
    order.push(`start:${id}`)
    if (holdId && untilId && id === holdId) {
      for (let i = 0; i < 100 && !order.includes(`start:${untilId}`); i++) await sleep(1)
    }
    order.push(`end:${id}`)
    return { content: `result-${id}`, isError: false }
  })
}

describe('query — lote de writes num turno', () => {
  it('3 writes a ficheiros distintos arrancam em paralelo e os tool_results mantêm ordem/ids', async () => {
    const order: string[] = []
    const batchDuringExec: boolean[] = []
    const executeTool = jest.fn(async (_n: string, _i: Record<string, unknown>, id: string) => {
      order.push(`start:${id}`)
      batchDuringExec.push(isInActiveWriteBatch(id))
      if (id === 'call_0') {
        for (let i = 0; i < 100 && !(order.includes('start:call_1') && order.includes('start:call_2')); i++) {
          await sleep(1)
        }
      }
      order.push(`end:${id}`)
      return { content: `result-${id}`, isError: false }
    })

    const { events } = await drainCollecting(
      query(baseParams({
        client: twoTurnClient([
          toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
          toolCallDelta(1, 'call_1', 'edit_file', '{"file_path":"/b.ts","old_string":"x","new_string":"y"}'),
          toolCallDelta(2, 'call_2', 'write_file', '{"file_path":"/c.ts","content":"z"}'),
          FINISH_TOOLS,
        ]),
        executeTool,
      })),
    )

    // call_1 e call_2 arrancaram ANTES de call_0 terminar — lote, não série.
    expect(order.indexOf('start:call_1')).toBeLessThan(order.indexOf('end:call_0'))
    expect(order.indexOf('start:call_2')).toBeLessThan(order.indexOf('end:call_0'))
    // Todos os membros viram o lote ativo durante a execução.
    expect(batchDuringExec).toEqual([true, true, true])
    // Lote fechado no fim do loop.
    expect(activeWriteBatchIds().size).toBe(0)
    // Contrato de resultados: ordem e ids intactos, uma execução por call.
    expect(executeTool).toHaveBeenCalledTimes(3)
    const results = events.filter((e) => e.type === 'tool_result') as Array<{
      type: 'tool_result'; toolUseId: string; content: string
    }>
    expect(results.map((r) => r.toolUseId)).toEqual(['call_0', 'call_1', 'call_2'])
    expect(results[0].content).toBe('result-call_0')
  })

  it('A,B,A: o 2.º write a A espera o 1.º; B corre em paralelo', async () => {
    const order: string[] = []
    const executeTool = makeProbeExecutor(order, 'call_0', 'call_1')

    await drainCollecting(
      query(baseParams({
        client: twoTurnClient([
          toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"1","new_string":"2"}'),
          toolCallDelta(1, 'call_1', 'edit_file', '{"file_path":"/b.ts","old_string":"1","new_string":"2"}'),
          toolCallDelta(2, 'call_2', 'edit_file', '{"file_path":"/a.ts","old_string":"2","new_string":"3"}'),
          FINISH_TOOLS,
        ]),
        executeTool,
      })),
    )

    // B paralelo a A(1)...
    expect(order.indexOf('start:call_1')).toBeLessThan(order.indexOf('end:call_0'))
    // ...mas A(2) só arranca DEPOIS de A(1) resolver (encadeado por caminho).
    expect(order.indexOf('start:call_2')).toBeGreaterThan(order.indexOf('end:call_0'))
    expect(executeTool).toHaveBeenCalledTimes(3)
  })

  it('um non-write quebra o grupo: write, execute_command, write correm em série', async () => {
    const order: string[] = []
    // call_0 segura ~30ms à espera de QUALQUER outro start — em lote apareceria.
    const executeTool = jest.fn(async (_n: string, _i: Record<string, unknown>, id: string) => {
      order.push(`start:${id}`)
      if (id === 'call_0') {
        for (let i = 0; i < 30 && order.length < 2; i++) await sleep(1)
      }
      order.push(`end:${id}`)
      return { content: `result-${id}`, isError: false }
    })

    await drainCollecting(
      query(baseParams({
        client: twoTurnClient([
          toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
          toolCallDelta(1, 'call_1', 'execute_command', '{"command":"npm test"}'),
          toolCallDelta(2, 'call_2', 'edit_file', '{"file_path":"/b.ts","old_string":"x","new_string":"y"}'),
          FINISH_TOOLS,
        ]),
        executeTool,
      })),
    )

    // Série estrita: nada arrancou enquanto call_0 corria.
    expect(order.slice(0, 2)).toEqual(['start:call_0', 'end:call_0'])
    expect(order.indexOf('start:call_2')).toBeGreaterThan(order.indexOf('end:call_1'))
    expect(executeTool).toHaveBeenCalledTimes(3)
  })

  it('1 só write degenera para o caminho serial clássico (sem lote)', async () => {
    const seenBatch: boolean[] = []
    const executeTool = jest.fn(async (_n: string, _i: Record<string, unknown>, id: string) => {
      seenBatch.push(isInActiveWriteBatch(id))
      return { content: `result-${id}`, isError: false }
    })

    const { events } = await drainCollecting(
      query(baseParams({
        client: twoTurnClient([
          toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
          FINISH_TOOLS,
        ]),
        executeTool,
      })),
    )

    expect(seenBatch).toEqual([false])
    expect(executeTool).toHaveBeenCalledTimes(1)
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(1)
  })

  it('caminho não extraível em QUALQUER membro serializa o grupo inteiro', async () => {
    const order: string[] = []
    const executeTool = jest.fn(async (_n: string, _i: Record<string, unknown>, id: string) => {
      order.push(`start:${id}`)
      if (id === 'call_0') {
        for (let i = 0; i < 30 && order.length < 2; i++) await sleep(1)
      }
      order.push(`end:${id}`)
      return { content: `result-${id}`, isError: false }
    })

    await drainCollecting(
      query(baseParams({
        client: twoTurnClient([
          toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
          // Sem file_path/path — chave de colisão indeterminável.
          toolCallDelta(1, 'call_1', 'edit_file', '{"old_string":"x","new_string":"y"}'),
          FINISH_TOOLS,
        ]),
        executeTool,
      })),
    )

    expect(order.slice(0, 2)).toEqual(['start:call_0', 'end:call_0'])
    expect(activeWriteBatchIds().size).toBe(0)
    expect(executeTool).toHaveBeenCalledTimes(2)
  })

  it('abort a meio do lote fecha o lote (endWriteBatch no finally)', async () => {
    const controller = new AbortController()
    const executeTool = jest.fn(async (_n: string, _i: Record<string, unknown>, id: string) => {
      if (id === 'call_0') controller.abort()
      return { content: `result-${id}`, isError: false }
    })

    await drainCollecting(
      query(baseParams({
        client: twoTurnClient([
          toolCallDelta(0, 'call_0', 'edit_file', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
          toolCallDelta(1, 'call_1', 'edit_file', '{"file_path":"/b.ts","old_string":"x","new_string":"y"}'),
          FINISH_TOOLS,
        ]),
        executeTool,
        signal: controller.signal,
      })),
    )

    // Independentemente de onde o loop saiu, o lote não pode ficar órfão:
    // um lote ativo deixaria o gate de diffs permissivo no turno seguinte.
    expect(activeWriteBatchIds().size).toBe(0)
  })
})
