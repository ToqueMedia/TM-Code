/**
 * Instrumentação da seleção dinâmica de tools (2026-07-13):
 *   - toolsetChurn no payloadInspector (proxy de invalidação de prompt cache)
 *   - contadores request_tools/defensive no ToolsetSelector
 */
import { inspectPayload, resetToolsetChurnTracking } from '../payloadInspector'
import { ToolsetSelector } from '../toolsetSelector'

function tool(name: string, description = 'd'): { type: string; function: unknown } {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } }
}

function inspect(tools: Array<{ type: string; function: unknown }>) {
  return inspectPayload([], undefined, tools as any, 'test-model', 1)
}

describe('payloadInspector toolset churn', () => {
  beforeEach(() => {
    resetToolsetChurnTracking()
  })

  it('first request is baseline, not a change', () => {
    const r = inspect([tool('read_file'), tool('edit_file')])
    expect(r.toolsetChurn.changed).toBe(false)
    expect(r.toolsetChurn.changesThisSession).toBe(0)
    expect(r.toolsetChurn.requestsThisSession).toBe(1)
  })

  it('stable toolset across requests → no churn', () => {
    inspect([tool('read_file'), tool('edit_file')])
    const r = inspect([tool('read_file'), tool('edit_file')])
    expect(r.toolsetChurn.changed).toBe(false)
    expect(r.toolsetChurn.changesThisSession).toBe(0)
    expect(r.toolsetChurn.requestsThisSession).toBe(2)
  })

  it('membership change → churn with added/removed names', () => {
    inspect([tool('read_file'), tool('edit_file')])
    const r = inspect([tool('read_file'), tool('write_file')])
    expect(r.toolsetChurn.changed).toBe(true)
    expect(r.toolsetChurn.added).toEqual(['write_file'])
    expect(r.toolsetChurn.removed).toEqual(['edit_file'])
    expect(r.toolsetChurn.changesThisSession).toBe(1)
  })

  it('same names but different schema bytes → churn (meta-tool descriptions mutate)', () => {
    inspect([tool('request_tools', 'inactive: write_file, delete_file')])
    const r = inspect([tool('request_tools', 'inactive: delete_file')])
    expect(r.toolsetChurn.changed).toBe(true)
    expect(r.toolsetChurn.added).toEqual([])
    expect(r.toolsetChurn.removed).toEqual([])
  })
})

describe('ToolsetSelector instrumentation stats', () => {
  it('counts request_tools calls and defensive activations', () => {
    const selector = new ToolsetSelector(
      ['read_file', 'edit_file', 'write_file', 'delete_file'],
      'bugfix_local',
    )
    expect(selector.getInstrumentationStats()).toEqual({
      requestToolsCalls: 0,
      defensiveActivations: 0,
      expandedNames: [],
      deniedNames: [],
    })

    selector.requestTools(['write_file'])
    selector.requestTools(['nonexistent_tool']) // conta como call na mesma — foi um round-trip
    expect(selector.expandForToolName('delete_file')).toBe(true)
    expect(selector.expandForToolName('delete_file')).toBe(false) // já ativo — não re-conta

    const stats = selector.getInstrumentationStats()
    expect(stats.requestToolsCalls).toBe(2)
    expect(stats.defensiveActivations).toBe(1)
    expect(stats.expandedNames).toEqual(expect.arrayContaining(['write_file', 'delete_file']))
  })
})
