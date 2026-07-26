/**
 * Mid-run `/plan` on a live task session — state restore contracts.
 */

import { tryPlanOnLiveRun, settlePlanOverrideOnRunEnd } from '../planOnLiveRun'

const mockRuns = new Map<string, {
  id: string
  sessionId: string
  status: string
  steerQueue: unknown[]
  planOverride?: unknown
}>()

const mockEnqueueSteer = jest.fn()
const mockSetPlanOverride = jest.fn()
const mockAppendMessage = jest.fn()
const mockSetPlanResume = jest.fn()
const mockAddCard = jest.fn()
const mockSetAutoApprove = jest.fn()
const mockSetRequestType = jest.fn()
const mockGetRequestType = jest.fn(() => null as string | null)

jest.mock('../../../../stores/parallelTaskStore', () => ({
  useParallelTaskStore: {
    getState: () => ({
      runs: mockRuns,
      enqueueSteer: mockEnqueueSteer,
      setPlanOverride: mockSetPlanOverride,
    }),
  },
}))

jest.mock('../../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      appendMessageToSession: mockAppendMessage,
      setPlanResumePending: mockSetPlanResume,
      addCardMessage: mockAddCard,
      addSystemMessage: jest.fn(),
      activeSessionId: 'sess-1',
      sessions: new Map([
        ['sess-1', { projectPath: '/proj', messages: [] }],
      ]),
    }),
  },
}))

jest.mock('../../../../stores/permissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      autoApproveDiffs: false,
      setAutoApproveDiffs: mockSetAutoApprove,
    }),
  },
}))

jest.mock('../../agentService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      setRequestType: mockSetRequestType,
      getRequestType: mockGetRequestType,
    }),
  },
}))

jest.mock('../../commands/planCommand', () => ({
  resolvePlanArtifact: jest.fn(async () => ({
    fileName: 'PLAN.md',
    path: '/proj/PLAN.md',
  })),
  buildArchitectSystemPrompt: jest.fn(() => 'ARCHITECT_SYSTEM'),
  buildArchitectUserMessage: jest.fn(() => 'ARCHITECT_USER'),
  readPlanReadiness: jest.fn(async () => ({ ready: true, content: 'Status: PENDING APPROVAL' })),
}))

jest.mock('../../hashtagRegistry', () => ({
  preprocessHashtags: () => ({ hasDesign: false }),
}))

jest.mock('../../aiAgentIntent', () => ({
  detectAiAgentIntent: () => null,
}))

jest.mock('../../../../i18n', () => ({
  t: (key: string) => key,
}))

describe('tryPlanOnLiveRun', () => {
  beforeEach(() => {
    mockRuns.clear()
    jest.clearAllMocks()
    mockGetRequestType.mockReturnValue(null)
  })

  it('returns none when no live run matches the session', async () => {
    const result = await tryPlanOnLiveRun('auth feature', '/proj', 'sess-missing')
    expect(result).toBe('none')
    expect(mockEnqueueSteer).not.toHaveBeenCalled()
  })

  it('returns usage for empty args without steering', async () => {
    mockRuns.set('task-1', {
      id: 'task-1',
      sessionId: 'sess-1',
      status: 'running',
      steerQueue: [],
    })
    expect(await tryPlanOnLiveRun('  ', '/proj', 'sess-1')).toBe('usage')
    expect(mockEnqueueSteer).not.toHaveBeenCalled()
  })

  it('steers a live running task and records restore metadata', async () => {
    mockRuns.set('task-1', {
      id: 'task-1',
      sessionId: 'sess-1',
      status: 'running',
      steerQueue: [],
    })

    const result = await tryPlanOnLiveRun('auth feature', '/proj', 'sess-1')

    expect(result).toBe('steered')
    expect(mockSetAutoApprove).toHaveBeenCalledWith(true)
    expect(mockSetRequestType).toHaveBeenCalledWith('plan')
    expect(mockSetPlanOverride).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        systemPrompt: 'ARCHITECT_SYSTEM',
        planFileName: 'PLAN.md',
        planPath: '/proj/PLAN.md',
        originalArgs: 'auth feature',
        prevAutoApproveDiffs: false,
        setRequestTypePlan: true,
        planModeOwnerId: expect.stringContaining('live-plan:task-1:'),
      }),
    )
    expect(mockEnqueueSteer).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ text: 'ARCHITECT_USER' }),
    )
  })
})

describe('settlePlanOverrideOnRunEnd', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetRequestType.mockReturnValue('plan')
  })

  it('restores auto-approve and clears requestType; cards the task session', async () => {
    await settlePlanOverrideOnRunEnd(
      {
        systemPrompt: 'x',
        planFileName: 'PLAN.md',
        planPath: '/proj/PLAN.md',
        originalArgs: 'auth',
        enabledAt: 1,
        planModeOwnerId: 'live-plan:task-1:1',
        prevAutoApproveDiffs: false,
        setRequestTypePlan: true,
      },
      '/proj',
      'sess-1',
    )

    expect(mockSetAutoApprove).toHaveBeenCalledWith(false)
    expect(mockSetRequestType).toHaveBeenCalledWith(null)
    expect(mockAddCard).toHaveBeenCalledWith(
      'plan_approval',
      '/proj',
      expect.objectContaining({ planPath: '/proj/PLAN.md' }),
      'sess-1',
    )
  })
})
