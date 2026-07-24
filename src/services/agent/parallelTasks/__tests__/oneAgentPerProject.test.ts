/**
 * F3 — one agent per project (`parallelTasks/policy.ts`):
 * addParallelTask refuses; addSessionAgentRun steers an existing live run
 * instead of spawning a second agent.
 */

import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { useChatStore } from '@/stores/chatStore'

jest.mock('../parallelTaskRunner', () => ({ runParallelTask: jest.fn() }))

jest.mock('../../../../stores/billingStore', () => ({
  useBillingStore: {
    getState: () => ({ noCredits: false, status: 'ok', isActive: true }),
  },
}))

jest.mock('../../../../stores/byokStore', () => ({
  useByokStore: {
    getState: () => ({
      enabled: false,
      resolveActive: () => null,
    }),
  },
}))

jest.mock('../../queryGuard', () => ({
  getQueryGuard: () => ({
    getSnapshot: () => false,
    subscribe: (cb: () => void) => () => { void cb },
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  addParallelTask,
  addSessionAgentRun,
  findLiveParallelRunForProject,
} = require('../parallelTaskManager') as typeof import('../parallelTaskManager')
const { ONE_AGENT_PER_PROJECT } = require('../policy') as typeof import('../policy')

describe('F3 — one agent per project', () => {
  it('exports ONE_AGENT_PER_PROJECT = true', () => {
    expect(ONE_AGENT_PER_PROJECT).toBe(true)
  })

  beforeEach(() => {
    useParallelTaskStore.setState({ runs: new Map() })
    useChatStore.getState().clearAllSessions()
  })

  it('addParallelTask always refuses (intra-project fan-out removed)', () => {
    const id = addParallelTask('build feature X')
    expect(id).toBeNull()
    expect(useParallelTaskStore.getState().runs.size).toBe(0)
  })

  it('addSessionAgentRun steers existing live run on same project', () => {
    // Seed a live run for project A
    const sid = useChatStore.getState().createSession('/work/proj-a')
    const runId = useParallelTaskStore.getState().createQueued(
      'first',
      'first',
      sid,
      '/work/proj-a',
      { continuation: true },
    )
    useParallelTaskStore.getState().markRunning(runId)

    expect(findLiveParallelRunForProject('/work/proj-a')).toBe(runId)

    const result = addSessionAgentRun(sid, 'steer me please')
    expect(result).toBe(runId)
    // No second run created
    expect(useParallelTaskStore.getState().runs.size).toBe(1)
    const run = useParallelTaskStore.getState().runs.get(runId)!
    expect(run.steerQueue.some(s => s.text.includes('steer me please'))).toBe(true)
  })

  it('addSessionAgentRun can spawn when project is free', () => {
    const sid = useChatStore.getState().createSession('/work/proj-b')
    const id = addSessionAgentRun(sid, 'work on B')
    expect(id).toBeTruthy()
    const run = useParallelTaskStore.getState().runs.get(id!)
    expect(run?.projectPath).toBe('/work/proj-b')
    expect(run?.continuation).toBe(true)
  })
})
