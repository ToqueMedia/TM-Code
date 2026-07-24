/**
 * F2 — addProjectRun binds work to a specific project path so the parallel
 * runner does not inherit currentProject after an in-window switch.
 */

import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { useChatStore } from '@/stores/chatStore'

jest.mock('../parallelTaskRunner', () => ({ runParallelTask: jest.fn() }))

jest.mock('../../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken: async () => 'tok' }) },
}))

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { addProjectRun } = require('../parallelTaskManager') as typeof import('../parallelTaskManager')

describe('addProjectRun (F2)', () => {
  beforeEach(() => {
    useParallelTaskStore.setState({ runs: new Map() })
    useChatStore.getState().clearAllSessions()
  })

  it('stamps projectPath on the queued run and creates a session under that path', () => {
    const id = addProjectRun(
      { id: 'proj-a', path: '/work/proj-a' },
      'implement feature X',
    )
    expect(id).toBeTruthy()
    const run = useParallelTaskStore.getState().runs.get(id!)
    expect(run?.projectPath).toBe('/work/proj-a')
    // pumpParallelTasks promotes immediately when under the concurrency cap
    expect(run?.status === 'queued' || run?.status === 'running').toBe(true)
    expect(run?.sessionId).toBeTruthy()
    const session = useChatStore.getState().sessions.get(run!.sessionId!)
    expect(session?.projectPath).toBe('/work/proj-a')
  })

  it('returns null when billing blocks', () => {
    const billing = require('../../../../stores/billingStore')
    const orig = billing.useBillingStore.getState
    billing.useBillingStore.getState = () => ({ noCredits: true, status: 'rejected', isActive: false })
    try {
      const id = addProjectRun({ id: 'p', path: '/work/p' }, 'hello')
      expect(id).toBeNull()
    } finally {
      billing.useBillingStore.getState = orig
    }
  })
})
