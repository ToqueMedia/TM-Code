import { withWriteLock, pendingWriteLockDepth } from '../writeSerializer'
import { useParallelTaskStore, MAX_CONCURRENT_TASKS } from '../../../../stores/parallelTaskStore'

// The manager lazy-imports the runner; stub it so pump() doesn't spin up a real
// agent loop. We assert the store's running/queued transitions instead.
jest.mock('../parallelTaskRunner', () => ({ runParallelTask: jest.fn() }))

describe('writeSerializer', () => {
  it('runs applies strictly one at a time (FIFO), never overlapping', async () => {
    const events: string[] = []
    let active = 0
    const make = (name: string) =>
      withWriteLock(async () => {
        active++
        expect(active).toBe(1) // never two at once
        events.push(`start:${name}`)
        await Promise.resolve()
        events.push(`end:${name}`)
        active--
      })

    await Promise.all([make('a'), make('b'), make('c')])
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
    expect(pendingWriteLockDepth()).toBe(0)
  })

  it('a rejecting apply does not break the chain for later waiters', async () => {
    const results: string[] = []
    const bad = withWriteLock(async () => {
      throw new Error('boom')
    }).catch((e) => results.push(`caught:${(e as Error).message}`))
    const good = withWriteLock(async () => {
      results.push('good-ran')
    })
    await Promise.all([bad, good])
    expect(results).toContain('caught:boom')
    expect(results).toContain('good-ran')
  })
})

describe('parallelTaskStore', () => {
  beforeEach(() => {
    useParallelTaskStore.setState({ runs: new Map() })
  })

  it('enqueues tasks and reports running/queued correctly', () => {
    const s = useParallelTaskStore.getState()
    const ids = Array.from({ length: 6 }, (_, i) => s.createQueued(`task ${i}`, `t${i}`))
    expect(useParallelTaskStore.getState().runningCount()).toBe(0)
    // Promote the first MAX to running (what the manager would do).
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
      const next = useParallelTaskStore.getState().nextQueuedId()
      expect(next).toBe(ids[i]) // FIFO order
      useParallelTaskStore.getState().markRunning(next!)
    }
    expect(useParallelTaskStore.getState().runningCount()).toBe(MAX_CONCURRENT_TASKS)
    // The 5th and 6th remain queued.
    expect(useParallelTaskStore.getState().nextQueuedId()).toBe(ids[4])
  })

  it('finalize frees a slot so the next queued task can be promoted', () => {
    const s = useParallelTaskStore.getState()
    const a = s.createQueued('a', 'a')
    const b = s.createQueued('b', 'b')
    s.markRunning(a)
    expect(useParallelTaskStore.getState().runningCount()).toBe(1)
    useParallelTaskStore.getState().finalize(a, 'done', { input: 10, output: 5 })
    expect(useParallelTaskStore.getState().runningCount()).toBe(0)
    // b is still queued and now next in line.
    expect(useParallelTaskStore.getState().nextQueuedId()).toBe(b)
    const finished = useParallelTaskStore.getState().runs.get(a)!
    expect(finished.status).toBe('completed')
    expect(finished.tokenUsage).toEqual({ input: 10, output: 5 })
  })

  it('abortAll aborts running and queued tasks', () => {
    const s = useParallelTaskStore.getState()
    const a = s.createQueued('a', 'a')
    const b = s.createQueued('b', 'b')
    s.markRunning(a)
    useParallelTaskStore.getState().abortAll()
    const runs = useParallelTaskStore.getState().runs
    expect(runs.get(a)!.status).toBe('aborted')
    expect(runs.get(b)!.status).toBe('aborted')
    expect(runs.get(a)!.abortController.signal.aborted).toBe(true)
  })

  it('clearFinished keeps only running/queued', () => {
    const s = useParallelTaskStore.getState()
    const a = s.createQueued('a', 'a')
    const b = s.createQueued('b', 'b')
    s.markRunning(a)
    useParallelTaskStore.getState().finalize(a, 'x', { input: 0, output: 0 })
    useParallelTaskStore.getState().clearFinished()
    const runs = useParallelTaskStore.getState().runs
    expect(runs.has(a)).toBe(false)
    expect(runs.has(b)).toBe(true)
  })
})

describe('parallelTaskManager', () => {
  beforeEach(() => {
    // NB: no jest.resetModules() — the manager is dynamically imported but must
    // share the SAME store module instance as this test's static import.
    useParallelTaskStore.setState({ runs: new Map() })
  })

  it('F3: addParallelTask refuses (intra-project fan-out removed)', async () => {
    const { addParallelTask } = await import('../parallelTaskManager')
    const { useChatStore } = await import('../../../../stores/chatStore')
    const seed = useChatStore.getState().createBackgroundSession('/tmp/test-project', 'seed')
    useChatStore.setState({ activeSessionId: seed })
    expect(addParallelTask('task 1')).toBeNull()
    expect(useParallelTaskStore.getState().runs.size).toBe(0)
  })

  it('pump promotes at most one run per projectPath (F3)', async () => {
    const { pumpParallelTasks } = await import('../parallelTaskManager')
    const { useChatStore } = await import('../../../../stores/chatStore')
    const sA = useChatStore.getState().createBackgroundSession('/tmp/proj-a', 'a')
    const sB = useChatStore.getState().createBackgroundSession('/tmp/proj-b', 'b')
    const store = useParallelTaskStore.getState()
    const a1 = store.createQueued('a1', 'a1', sA, '/tmp/proj-a', { continuation: true })
    const a2 = store.createQueued('a2', 'a2', sA, '/tmp/proj-a', { continuation: true })
    const b1 = store.createQueued('b1', 'b1', sB, '/tmp/proj-b', { continuation: true })
    pumpParallelTasks()
    const runs = useParallelTaskStore.getState().runs
    // A and B can both run; second A stays queued
    expect(runs.get(a1)?.status).toBe('running')
    expect(runs.get(a2)?.status).toBe('queued')
    expect(runs.get(b1)?.status).toBe('running')
  })
})
