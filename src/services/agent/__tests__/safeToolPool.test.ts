/**
 * safeToolPool tests — verify concurrency-safety classification, batch
 * sizing, ordering, and abort handling.
 *
 * The pool's contract:
 *   - Concurrency-safe tools run in parallel up to MAX_PARALLEL.
 *   - Non-safe tools run alone (no other tool in-flight).
 *   - Results are returned in INPUT order (not completion order).
 *   - Telemetry counters track batch sizes and conflicts.
 */

jest.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ pendingDiffs: [] }),
    subscribe: jest.fn(() => jest.fn()),
  },
}))

jest.mock('../../../stores/credentialRequestStore', () => ({
  useCredentialRequestStore: {
    getState: () => ({ pending: new Map() }),
    subscribe: jest.fn(() => jest.fn()),
  },
}))

import { executeToolCalls, type PoolToolCall } from '../safeToolPool'
import type ToolExecutor from '../toolExecutor'

/**
 * Build a fake ToolExecutor that records execution order and timing,
 * with controllable per-tool delays. The fake honors the same
 * `isConcurrencySafe(name)` contract as the real one.
 */
function makeFakeExecutor(opts: {
  /** Map of tool name → "safe" classification. */
  safeMap: Record<string, boolean>
  /** Map of tool name → execution delay in ms. Default 10ms. */
  delays?: Record<string, number>
  /** Tool names that should throw an error. */
  errors?: Set<string>
  /** Tool names that should return a diff JSON instead of plain text. */
  diffs?: Set<string>
}): {
  executor: Pick<ToolExecutor, 'isConcurrencySafe' | 'execute'>
  events: Array<{ event: 'start' | 'end'; name: string; id: string; t: number }>
} {
  const events: Array<{ event: 'start' | 'end'; name: string; id: string; t: number }> = []
  const t0 = Date.now()

  return {
    events,
    executor: {
      isConcurrencySafe(name: string): boolean {
        return opts.safeMap[name] === true
      },
      async execute(name: string, _input: Record<string, unknown>, id?: string): Promise<string> {
        const idStr = id || ''
        events.push({ event: 'start', name, id: idStr, t: Date.now() - t0 })
        const delay = opts.delays?.[name] ?? 10
        await new Promise(r => setTimeout(r, delay))
        events.push({ event: 'end', name, id: idStr, t: Date.now() - t0 })

        if (opts.errors?.has(name)) {
          throw new Error(`Tool ${name} failed`)
        }
        if (opts.diffs?.has(name)) {
          return JSON.stringify({
            type: 'diff',
            path: `/fake/${name}.ts`,
            isNewFile: false,
            newContent: 'updated',
          })
        }
        return `result-${idStr || name}`
      },
    },
  }
}

/**
 * Compute, for each tool id, the time window [start, end] from events.
 * Used to assert overlap (or lack thereof) between tools.
 */
function windowsById(events: Array<{ event: 'start' | 'end'; id: string; t: number }>) {
  const w = new Map<string, { start: number; end: number }>()
  for (const e of events) {
    if (e.event === 'start') {
      w.set(e.id, { start: e.t, end: -1 })
    } else {
      const cur = w.get(e.id)
      if (cur) cur.end = e.t
    }
  }
  return w
}

/** True iff any pair in the given id list has overlapping execution windows. */
function anyOverlap(events: Array<{ event: 'start' | 'end'; id: string; t: number }>, ids: string[]): boolean {
  const w = windowsById(events)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = w.get(ids[i])
      const b = w.get(ids[j])
      if (!a || !b) continue
      // overlap iff a.start < b.end and b.start < a.end
      if (a.start < b.end && b.start < a.end) return true
    }
  }
  return false
}

const calls = (defs: Array<[string, string]>): PoolToolCall[] =>
  defs.map(([id, name]) => ({ id, name, args: {} }))

describe('safeToolPool', () => {
  describe('concurrency classification', () => {
    it('runs 5 read-safe tools in parallel', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
        delays: { read_file: 50 },
      })

      const toolCalls = calls([
        ['t1', 'read_file'],
        ['t2', 'read_file'],
        ['t3', 'read_file'],
        ['t4', 'read_file'],
        ['t5', 'read_file'],
      ])

      const { results, telemetry } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      // All 5 should be in the same parallel batch.
      expect(telemetry.parallelBatchSizes).toEqual([5])
      expect(telemetry.maxParallelObserved).toBe(5)
      expect(telemetry.concurrencyConflictsAvoided).toBe(0)
      expect(results.every(r => r !== null && !r.isError)).toBe(true)
      // Total duration should be ~50ms (parallel), not ~250ms (serial).
      expect(telemetry.totalDurationMs).toBeLessThan(200)
    })

    it('forces 3 non-safe tools to run serially', async () => {
      const { executor, events } = makeFakeExecutor({
        safeMap: { write_file: false },
        delays: { write_file: 30 },
      })

      const toolCalls = calls([
        ['w1', 'write_file'],
        ['w2', 'write_file'],
        ['w3', 'write_file'],
      ])

      const { results, telemetry } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      // Each non-safe tool gets its own size-1 batch.
      expect(telemetry.parallelBatchSizes).toEqual([1, 1, 1])
      expect(telemetry.maxParallelObserved).toBe(1)
      // Verify pairwise non-overlap
      expect(anyOverlap(events, ['w1', 'w2', 'w3'])).toBe(false)
      expect(results.every(r => r !== null && !r.isError)).toBe(true)
    })

    it('mixed: read | write | read serializes correctly', async () => {
      const { executor, events } = makeFakeExecutor({
        safeMap: { read_file: true, write_file: false },
        delays: { read_file: 30, write_file: 30 },
      })

      const toolCalls = calls([
        ['r1', 'read_file'],
        ['w1', 'write_file'],
        ['r2', 'read_file'],
      ])

      const { results, telemetry } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      // r1 alone, then w1 alone, then r2 alone — three batches of size 1.
      expect(telemetry.parallelBatchSizes).toEqual([1, 1, 1])
      // None of them should overlap.
      expect(anyOverlap(events, ['r1', 'w1'])).toBe(false)
      expect(anyOverlap(events, ['w1', 'r2'])).toBe(false)
      expect(results.every(r => r !== null && !r.isError)).toBe(true)
    })

    it('two reads can parallelize but a third write must wait', async () => {
      const { executor, events } = makeFakeExecutor({
        safeMap: { read_file: true, execute_command: false },
        delays: { read_file: 40, execute_command: 20 },
      })

      const toolCalls = calls([
        ['r1', 'read_file'],
        ['r2', 'read_file'],
        ['c1', 'execute_command'],
      ])

      const { results, telemetry } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      // r1 + r2 parallel = batch of 2; c1 alone = batch of 1.
      expect(telemetry.parallelBatchSizes).toEqual([2, 1])
      // r1 and r2 overlap each other
      expect(anyOverlap(events, ['r1', 'r2'])).toBe(true)
      // Neither overlaps c1
      expect(anyOverlap(events, ['r1', 'c1'])).toBe(false)
      expect(anyOverlap(events, ['r2', 'c1'])).toBe(false)
      expect(results.length).toBe(3)
    })

    it('respects maxParallel cap', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
        delays: { read_file: 30 },
      })

      const toolCalls = calls([
        ['r1', 'read_file'],
        ['r2', 'read_file'],
        ['r3', 'read_file'],
        ['r4', 'read_file'],
        ['r5', 'read_file'],
      ])

      const { telemetry } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
        maxParallel: 2,
      })

      expect(telemetry.maxParallelObserved).toBe(2)
      // 5 reads through a 2-cap pool: at minimum 3 dispatch waves.
      // Total time is ~3 * 30ms = 90ms (vs ~30ms unlimited).
      expect(telemetry.totalDurationMs).toBeGreaterThanOrEqual(60)
    })
  })

  describe('result ordering', () => {
    it('returns results in input order even when completion order differs', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
        delays: { read_file: 0 }, // unused
      })

      // Override delays per id by wrapping execute
      const realExecute = executor.execute
      const delays: Record<string, number> = { 'a': 50, 'b': 10, 'c': 30 }
      executor.execute = async (name, input, id) => {
        const delay = delays[id || ''] ?? 10
        await new Promise(r => setTimeout(r, delay))
        return realExecute(name, input, id)
      }

      const toolCalls = calls([
        ['a', 'read_file'],
        ['b', 'read_file'],
        ['c', 'read_file'],
      ])

      const { results } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      // Results in input order, not completion order
      expect(results[0]?.toolCall.id).toBe('a')
      expect(results[1]?.toolCall.id).toBe('b')
      expect(results[2]?.toolCall.id).toBe('c')
    })
  })

  describe('callbacks', () => {
    it('fires onToolStart and onToolResult in correct order', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
      })

      const order: string[] = []
      await executeToolCalls({
        toolCalls: calls([['t1', 'read_file']]),
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
        onToolStart: (tc) => {
          order.push(`start:${tc.id}`)
        },
        onToolResult: (tc) => {
          order.push(`result:${tc.id}`)
        },
      })

      expect(order).toEqual(['start:t1', 'result:t1'])
    })

    it('fires onToolResult with isError=true on failure', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { broken: true },
        errors: new Set(['broken']),
      })

      let captured: { isError: boolean; raw: string } | null = null
      const { results } = await executeToolCalls({
        toolCalls: calls([['t1', 'broken']]),
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
        onToolResult: (_tc, raw, isError) => {
          captured = { raw, isError }
        },
      })

      expect(captured).not.toBeNull()
      expect(captured!.isError).toBe(true)
      expect(captured!.raw).toContain('broken')
      expect(results[0]?.isError).toBe(true)
    })

    // Regression tests for "callback throws crashes the pool" bug.
    // Before fix #1 (R1), a throw inside onToolStart would propagate as
    // unhandled rejection through Promise.race and crash the dispatch loop.
    // Each test wraps spy/restore in try/finally so an assertion failure
    // can never leak a mocked console.error to subsequent tests.
    it('survives a sync throw in onToolStart', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
      })

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { results } = await executeToolCalls({
          toolCalls: calls([
            ['t1', 'read_file'],
            ['t2', 'read_file'],
            ['t3', 'read_file'],
          ]),
          toolExecutor: executor as unknown as ToolExecutor,
          abortSignal: null,
          onToolStart: (tc) => {
            if (tc.id === 't2') throw new Error('boom in onToolStart')
          },
        })

        // All three tools must still complete — the buggy callback only
        // affects the one tool's start hook, not its execution or its peers.
        expect(results[0]).not.toBeNull()
        expect(results[1]).not.toBeNull()
        expect(results[2]).not.toBeNull()
        expect(results.every(r => r !== null && !r.isError)).toBe(true)

        // The error must have been swallowed and logged.
        const calledForOnToolStart = errSpy.mock.calls.some(
          c => typeof c[0] === 'string' && c[0].includes('onToolStart'),
        )
        expect(calledForOnToolStart).toBe(true)
      } finally {
        errSpy.mockRestore()
      }
    })

    it('survives a sync throw in onToolResult', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
      })

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { results } = await executeToolCalls({
          toolCalls: calls([
            ['t1', 'read_file'],
            ['t2', 'read_file'],
          ]),
          toolExecutor: executor as unknown as ToolExecutor,
          abortSignal: null,
          onToolResult: (tc) => {
            if (tc.id === 't1') throw new Error('boom in onToolResult')
          },
        })

        expect(results[0]).not.toBeNull()
        expect(results[1]).not.toBeNull()
        expect(results.every(r => r !== null && !r.isError)).toBe(true)

        const calledForOnToolResult = errSpy.mock.calls.some(
          c => typeof c[0] === 'string' && c[0].includes('onToolResult'),
        )
        expect(calledForOnToolResult).toBe(true)
      } finally {
        errSpy.mockRestore()
      }
    })

    // Regression test for R2-1: async callbacks that return rejected
    // promises must NOT crash the pool either. Synchronous try/catch
    // doesn't catch promise rejections — safeFireCallback has to detect
    // the thenable return and attach a .catch handler.
    it('survives an async callback that rejects (onToolStart)', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
      })

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { results } = await executeToolCalls({
          toolCalls: calls([
            ['t1', 'read_file'],
            ['t2', 'read_file'],
          ]),
          toolExecutor: executor as unknown as ToolExecutor,
          abortSignal: null,
          // Async callback that rejects — must NOT crash the pool.
          // The interface was tightened in R3-1 to accept `void | Promise<void>`,
          // so this no longer needs a cast — the type system reflects the
          // runtime's async-safe contract.
          onToolStart: async (tc) => {
            if (tc.id === 't1') throw new Error('async boom in onToolStart')
          },
        })

        expect(results[0]).not.toBeNull()
        expect(results[1]).not.toBeNull()
        expect(results.every(r => r !== null && !r.isError)).toBe(true)

        // Wait a tick so the async catch handler has time to fire.
        await new Promise(r => setTimeout(r, 10))

        const calledForAsync = errSpy.mock.calls.some(
          c => typeof c[0] === 'string' && c[0].includes('async callback rejected'),
        )
        expect(calledForAsync).toBe(true)
      } finally {
        errSpy.mockRestore()
      }
    })
  })

  describe('diff parsing', () => {
    it('parses diff JSON returned by write tools', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { write_file: false },
        diffs: new Set(['write_file']),
      })

      const { results } = await executeToolCalls({
        toolCalls: calls([['w1', 'write_file']]),
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      expect(results[0]?.parsedDiff).not.toBeNull()
      expect(results[0]?.parsedDiff?.path).toBe('/fake/write_file.ts')
      expect(results[0]?.parsedDiff?.newContent).toBe('updated')
    })

    it('leaves parsedDiff null for non-diff results', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true },
      })

      const { results } = await executeToolCalls({
        toolCalls: calls([['t1', 'read_file']]),
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      expect(results[0]?.parsedDiff).toBeNull()
    })
  })

  describe('abort handling', () => {
    it('stops dispatching new tools after abort but lets in-flight finish', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: false }, // serial — easier to predict
        delays: { read_file: 50 },
      })

      const ac = new AbortController()
      const toolCalls = calls([
        ['t1', 'read_file'],
        ['t2', 'read_file'],
        ['t3', 'read_file'],
      ])

      // Abort after 20ms — t1 should finish (serial, ~50ms), t2/t3 should not start
      setTimeout(() => ac.abort(), 20)

      const { results } = await executeToolCalls({
        toolCalls,
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: ac.signal,
      })

      expect(results[0]).not.toBeNull()
      expect(results[0]?.toolCall.id).toBe('t1')
      // t2 and t3 should never have run
      expect(results[1]).toBeNull()
      expect(results[2]).toBeNull()
    })
  })

  describe('telemetry', () => {
    it('counts safe vs serial correctly', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true, write_file: false },
      })

      const { telemetry } = await executeToolCalls({
        toolCalls: calls([
          ['r1', 'read_file'],
          ['r2', 'read_file'],
          ['w1', 'write_file'],
          ['r3', 'read_file'],
        ]),
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      expect(telemetry.totalTools).toBe(4)
      expect(telemetry.concurrencySafeCount).toBe(3)
      expect(telemetry.serialCount).toBe(1)
    })

    it('counts conflicts when a write blocks a queued read', async () => {
      const { executor } = makeFakeExecutor({
        safeMap: { read_file: true, write_file: false },
        delays: { write_file: 30, read_file: 10 },
      })

      const { telemetry } = await executeToolCalls({
        toolCalls: calls([
          ['w1', 'write_file'],
          ['r1', 'read_file'], // waits for w1
        ]),
        toolExecutor: executor as unknown as ToolExecutor,
        abortSignal: null,
      })

      // r1 was blocked at least once while w1 was in-flight
      expect(telemetry.concurrencyConflictsAvoided).toBeGreaterThanOrEqual(1)
    })
  })
})
