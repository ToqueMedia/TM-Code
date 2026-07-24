/**
 * stopProjectAgent — per-project Stop from the Welcome sidebar:
 * local parallel abort, local main stop, path normalization, remote request.
 */

export {}

const mockAbort = jest.fn()
const mockRuns = new Map<string, {
  id: string
  projectPath?: string
  status: string
}>()

jest.mock('@/stores/parallelTaskStore', () => ({
  useParallelTaskStore: {
    getState: () => ({
      runs: mockRuns,
      abort: mockAbort,
    }),
  },
}))

const mockStopAgentRun = jest.fn(() => true)
jest.mock('../stopAgentRun', () => ({
  stopAgentRun: () => mockStopAgentRun(),
}))

const mockRequestProjectAgentStop = jest.fn(async (_path?: string) => {})
const mockRequestTaskStop = jest.fn(async (_path?: string, _sessionId?: string) => {})
jest.mock('../parallelTasks/taskStopRequestService', () => ({
  requestProjectAgentStop: (path: string) => mockRequestProjectAgentStop(path),
  requestTaskStop: (path: string, sessionId: string) => mockRequestTaskStop(path, sessionId),
}))

jest.mock('../sessionService', () => ({
  sessionService: {
    listSessions: jest.fn(async () => []),
  },
}))

const mockGetProjectContext = jest.fn(() => null as { projectPath: string } | null)
const mockIsAgentRunning = jest.fn(() => false)

jest.mock('../toolExecutor', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getProjectContext: mockGetProjectContext }),
  },
}))

jest.mock('../agentService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ isAgentRunning: mockIsAgentRunning }),
  },
}))

jest.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: { path: '/work/focused' } }),
  },
}))

const mockSessions = new Map<string, { projectPath?: string }>()
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      streamingSessionId: null as string | null,
      sessions: mockSessions,
      getActiveSession: () => null,
      isStreaming: false,
    }),
  },
}))

jest.mock('@/stores/agentStore', () => ({
  useAgentStore: {
    getState: () => ({ status: 'idle' as string }),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stopProjectAgent } = require('../stopProjectAgent') as typeof import('../stopProjectAgent')

describe('stopProjectAgent', () => {
  beforeEach(() => {
    mockRuns.clear()
    mockSessions.clear()
    mockAbort.mockClear()
    mockStopAgentRun.mockClear().mockReturnValue(true)
    mockRequestProjectAgentStop.mockClear()
    mockRequestTaskStop.mockClear()
    mockGetProjectContext.mockReturnValue(null)
    mockIsAgentRunning.mockReturnValue(false)
  })

  it('aborts a local parallel run even when path slash form differs', () => {
    mockRuns.set('task-1', {
      id: 'task-1',
      projectPath: '/work/proj-a',
      status: 'running',
    })
    const ok = stopProjectAgent('/work/proj-a/')
    expect(ok).toBe(true)
    expect(mockAbort).toHaveBeenCalledWith('task-1')
    expect(mockStopAgentRun).not.toHaveBeenCalled()
    // Local success must NOT write disk stop (would kill a restart).
    expect(mockRequestProjectAgentStop).not.toHaveBeenCalled()
  })

  it('stops main when tool context matches the project', () => {
    mockGetProjectContext.mockReturnValue({ projectPath: '/work/proj-b' })
    mockIsAgentRunning.mockReturnValue(true)
    const ok = stopProjectAgent('/work/proj-b')
    expect(ok).toBe(true)
    expect(mockStopAgentRun).toHaveBeenCalled()
    expect(mockAbort).not.toHaveBeenCalled()
  })

  it('does not stop main for a different project', () => {
    mockGetProjectContext.mockReturnValue({ projectPath: '/work/other' })
    mockIsAgentRunning.mockReturnValue(true)
    const ok = stopProjectAgent('/work/proj-c')
    expect(ok).toBe(false)
    expect(mockStopAgentRun).not.toHaveBeenCalled()
    // Still writes remote stop so the owning window can react.
    expect(mockRequestProjectAgentStop).toHaveBeenCalledWith('/work/proj-c')
  })

  it('requests remote stop when nothing is local', () => {
    const ok = stopProjectAgent('/work/remote-only')
    expect(ok).toBe(false)
    expect(mockRequestProjectAgentStop).toHaveBeenCalledWith('/work/remote-only')
  })
})
