import { createSubAgentVisibility, type VisibilityHooks } from '../subAgentVisibility'

/** Build a spy set of hooks + a call log so each test can assert ordering. */
function buildHooks(): {
  hooks: VisibilityHooks
  calls: Array<[string, unknown[]]>
} {
  const calls: Array<[string, unknown[]]> = []
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, args]) }
  return {
    calls,
    hooks: {
      appendTextDelta: record('appendTextDelta'),
      appendReasoningDelta: record('appendReasoningDelta'),
      addPendingToolCall: record('addPendingToolCall'),
      updateToolCallWithArgs: record('updateToolCallWithArgs'),
      updateToolCallWithResult: record('updateToolCallWithResult'),
      setStatus: record('setStatus'),
    },
  }
}

describe('createSubAgentVisibility', () => {
  describe('reasoning separator', () => {
    it('prefixes the first reasoning delta with a labelled separator', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ reasoningLabel: 'research sub-agent', hooks })

      v.callbacks.onReasoningDelta('first thought')

      expect(calls.map(c => c[0])).toEqual([
        'appendReasoningDelta',
        'appendReasoningDelta',
        'setStatus',
      ])
      expect(calls[0][1][0]).toBe('\n\n— research sub-agent —\n\n')
      expect(calls[1][1][0]).toBe('first thought')
    })

    it('emits the separator only once — subsequent deltas pass through', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ reasoningLabel: 'verify sub-agent', hooks })

      v.callbacks.onReasoningDelta('a')
      v.callbacks.onReasoningDelta('b')
      v.callbacks.onReasoningDelta('c')

      const reasoningCalls = calls
        .filter(c => c[0] === 'appendReasoningDelta')
        .map(c => c[1][0])
      expect(reasoningCalls).toEqual([
        '\n\n— verify sub-agent —\n\n',
        'a',
        'b',
        'c',
      ])
    })
  })

  describe('status transitions', () => {
    it('ticks status as generating / thinking / applying per event kind', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ reasoningLabel: 'x', hooks })

      v.callbacks.onTextDelta('hi')
      v.callbacks.onReasoningDelta('ponder')
      v.callbacks.onToolCallPending('t1', 'read_file')

      const statuses = calls
        .filter(c => c[0] === 'setStatus')
        .map(c => c[1][0])
      expect(statuses).toEqual(['generating', 'thinking', 'applying'])
    })

    it('skips status updates gracefully when setStatus hook is absent', () => {
      const { hooks } = buildHooks()
      const hooksNoStatus: VisibilityHooks = { ...hooks, setStatus: undefined }
      const v = createSubAgentVisibility({ reasoningLabel: 'x', hooks: hooksNoStatus })

      // Should not throw.
      expect(() => v.callbacks.onTextDelta('hi')).not.toThrow()
      expect(() => v.callbacks.onReasoningDelta('p')).not.toThrow()
      expect(() => v.callbacks.onToolCallPending('t1', 'read_file')).not.toThrow()
    })
  })

  describe('tool-call fan-out with spawnedBy', () => {
    it('passes parentToolCallId as spawnedBy on addPendingToolCall', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({
        parentToolCallId: 'parent-123',
        reasoningLabel: 'research sub-agent',
        hooks,
      })

      v.callbacks.onToolCallPending('child-1', 'read_file')

      const pending = calls.find(c => c[0] === 'addPendingToolCall')
      expect(pending).toBeDefined()
      expect(pending![1]).toEqual(['child-1', 'read_file', 'parent-123', undefined])
    })

    it('skips addPendingToolCall entirely when parentToolCallId is undefined', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ reasoningLabel: 'x', hooks })

      v.callbacks.onToolCallPending('child-1', 'read_file')

      expect(calls.find(c => c[0] === 'addPendingToolCall')).toBeUndefined()
      // But the child is still tracked for orphan cleanup:
      expect(v.inFlightCount()).toBe(1)
    })

    it('forwards args + result for child tool calls', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ parentToolCallId: 'p', reasoningLabel: 'x', hooks })

      v.callbacks.onToolCallPending('c1', 'read_file')
      v.callbacks.onToolCallStart('c1', 'read_file', { path: '/foo.ts' })
      v.callbacks.onToolResult('c1', 'read_file', 'contents', false)

      const argsCall = calls.find(c => c[0] === 'updateToolCallWithArgs')!
      expect(argsCall[1]).toEqual(['c1', { path: '/foo.ts' }, undefined])

      const resultCall = calls.find(c => c[0] === 'updateToolCallWithResult')!
      expect(resultCall[1]).toEqual(['c1', 'contents', false, undefined])
    })
  })

  describe('targetMessageId plumbing (bg-agent post-turn)', () => {
    it('forwards targetMessageId to every store write when provided', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({
        parentToolCallId: 'p',
        reasoningLabel: 'background sub-agent',
        targetMessageId: 'msg-abc',
        hooks,
      })

      v.callbacks.onToolCallPending('c1', 'read_file')
      v.callbacks.onToolCallStart('c1', 'read_file', { path: '/foo' })
      v.callbacks.onToolResult('c1', 'read_file', 'ok', false)

      const targetIds = calls
        .filter(c => ['addPendingToolCall', 'updateToolCallWithArgs', 'updateToolCallWithResult'].includes(c[0]))
        .map(c => {
          // spawnedBy is the 3rd arg for addPending; targetMessageId is the last.
          return c[1][c[1].length - 1]
        })
      expect(targetIds).toEqual(['msg-abc', 'msg-abc', 'msg-abc'])
    })
  })

  describe('in-flight tracking + orphan cleanup', () => {
    it('counts pending tool calls and clears them on result', () => {
      const { hooks } = buildHooks()
      const v = createSubAgentVisibility({ parentToolCallId: 'p', reasoningLabel: 'x', hooks })

      v.callbacks.onToolCallPending('c1', 'read_file')
      v.callbacks.onToolCallPending('c2', 'write_file')
      expect(v.inFlightCount()).toBe(2)

      v.callbacks.onToolResult('c1', 'read_file', 'ok', false)
      expect(v.inFlightCount()).toBe(1)

      v.callbacks.onToolResult('c2', 'write_file', 'ok', false)
      expect(v.inFlightCount()).toBe(0)
    })

    it('marks all in-flight children as failed on cleanup', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ parentToolCallId: 'p', reasoningLabel: 'x', hooks })

      v.callbacks.onToolCallPending('c1', 'read_file')
      v.callbacks.onToolCallPending('c2', 'execute_command')
      v.callbacks.onToolResult('c1', 'read_file', 'ok', false)
      // c1 completed; only c2 is in-flight.
      expect(v.inFlightCount()).toBe(1)

      v.cleanupOrphans('aborted: x failed — boom')

      const resultCalls = calls
        .filter(c => c[0] === 'updateToolCallWithResult')
        .map(c => c[1])

      // One for the clean c1 result, one for the orphan c2.
      expect(resultCalls).toHaveLength(2)
      const orphanCall = resultCalls[1]
      expect(orphanCall[0]).toBe('c2')
      expect(orphanCall[1]).toBe('aborted: x failed — boom')
      expect(orphanCall[2]).toBe(true) // isError
      expect(v.inFlightCount()).toBe(0)
    })

    it('cleanupOrphans is idempotent — calling twice does nothing the second time', () => {
      const { hooks, calls } = buildHooks()
      const v = createSubAgentVisibility({ parentToolCallId: 'p', reasoningLabel: 'x', hooks })

      v.callbacks.onToolCallPending('c1', 'read_file')
      v.cleanupOrphans('r1')
      const firstCount = calls.filter(c => c[0] === 'updateToolCallWithResult').length

      v.cleanupOrphans('r2')
      const secondCount = calls.filter(c => c[0] === 'updateToolCallWithResult').length

      expect(secondCount).toBe(firstCount)
    })
  })
})
