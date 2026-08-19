import { normalizeIncomingTasks } from '../taskOps'

describe('normalizeIncomingTasks', () => {
  it('keeps a well-formed tasks array', () => {
    const out = normalizeIncomingTasks({
      tasks: [{ id: '1.1', status: 'in_progress' }],
    })
    expect(out).toEqual({ tasks: [{ id: '1.1', status: 'in_progress' }] })
  })

  it('wraps a single task object (the crash that retried as TypeError)', () => {
    const out = normalizeIncomingTasks({
      tasks: { id: '1.1', status: 'completed', evidence: 'tsc clean' },
    })
    expect('tasks' in out && out.tasks).toEqual([
      { id: '1.1', status: 'completed', evidence: 'tsc clean' },
    ])
  })

  it('coerces numeric-keyed objects as arrays', () => {
    const out = normalizeIncomingTasks({
      tasks: {
        '0': { id: '1.1', status: 'in_progress' },
        '1': { id: '1.2', status: 'pending' },
      },
    })
    expect('tasks' in out && out.tasks.map((t) => t.id)).toEqual(['1.1', '1.2'])
  })

  it('coerces an id-keyed map', () => {
    const out = normalizeIncomingTasks({
      tasks: {
        '1.1': { status: 'completed', evidence: '14 tests pass' },
        '1.2': { status: 'in_progress' },
      },
    })
    expect('tasks' in out && out.tasks).toEqual([
      { id: '1.1', status: 'completed', evidence: '14 tests pass' },
      { id: '1.2', status: 'in_progress' },
    ])
  })

  it('parses a JSON string of tasks', () => {
    const out = normalizeIncomingTasks({
      tasks: JSON.stringify([{ id: '2.1', status: 'pending', description: 'seed' }]),
    })
    expect('tasks' in out && out.tasks[0]).toMatchObject({ id: '2.1', status: 'pending' })
  })

  it('accepts the payload itself as the array', () => {
    const out = normalizeIncomingTasks([{ id: '1.1', status: 'pending' }])
    expect('tasks' in out && out.tasks[0].id).toBe('1.1')
  })

  it('maps TodoWrite todos that already have ids (content → description)', () => {
    const out = normalizeIncomingTasks({
      todos: [{ id: '1.1', content: 'wire endpoint', status: 'in_progress' }],
    })
    expect('tasks' in out && out.tasks[0]).toMatchObject({
      id: '1.1',
      description: 'wire endpoint',
      status: 'in_progress',
    })
  })

  it('rejects TodoWrite todos without ids instead of inventing tracker rows', () => {
    const out = normalizeIncomingTasks({
      todos: [{ content: 'wire endpoint', status: 'pending' }],
    })
    expect('error' in out && out.error).toContain('todos')
    expect('error' in out && out.error).toContain('existing tracker IDs')
  })

  it('returns a model-facing error instead of throwing when tasks is missing', () => {
    const out = normalizeIncomingTasks({})
    expect('error' in out && out.error).toContain('No `tasks` array')
  })

  it('returns a model-facing error for null / empty object tasks', () => {
    expect('error' in normalizeIncomingTasks({ tasks: null })).toBe(true)
    expect('error' in normalizeIncomingTasks({ tasks: {} })).toBe(true)
  })
})
