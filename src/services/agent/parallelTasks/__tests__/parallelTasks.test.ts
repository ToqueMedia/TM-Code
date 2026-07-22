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

  it('promotes only up to MAX_CONCURRENT_TASKS, queues the rest', async () => {
    const { addParallelTask } = await import('../parallelTaskManager')
    // CONTRATO DURO (2026-07-17): sem sessão ativa não há tarefa — dá ao
    // manager uma sessão de projecto para as tarefas nascerem COM chat.
    const { useChatStore } = await import('../../../../stores/chatStore')
    const seed = useChatStore.getState().createBackgroundSession('/tmp/test-project', 'seed')
    useChatStore.setState({ activeSessionId: seed })
    // Billing pré-voo devolve null quando bloqueado — aqui não está (store default).
    const ids = Array.from({ length: 6 }, (_, i) => addParallelTask(`task ${i}`)).filter((x): x is string => x !== null)
    expect(ids).toHaveLength(6)
    // Manager marks the first 4 running; 2 stay queued.
    const runs = useParallelTaskStore.getState().runs
    const running = ids.filter((id) => runs.get(id)!.status === 'running')
    const queued = ids.filter((id) => runs.get(id)!.status === 'queued')
    expect(running).toHaveLength(MAX_CONCURRENT_TASKS)
    expect(queued).toHaveLength(2)
  })
})
