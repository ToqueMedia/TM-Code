/**
 * stopAgentRun — o contrato único dos dois botões Stop: mata o trabalho
 * vivo, descarta orientações, PARQUEIA tarefas (pausa em vez de destruir
 * ou de as deixar disparar no instante em que o guard fica idle).
 */

export {}

const mockCancelLoop = jest.fn()
jest.mock('@/services/agent/agentService', () => ({
  __esModule: true,
  default: { getInstance: () => ({ cancelLoop: mockCancelLoop }) },
}))

const mockAbortAll = jest.fn()
jest.mock('@/stores/subAgentStore', () => ({
  useSubAgentStore: { getState: () => ({ abortAll: mockAbortAll }) },
}))

const mockFinalize = jest.fn()
const mockResolveAllDiffs = jest.fn()
jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ finalizeAssistantMessage: mockFinalize }) },
  resolveAllPendingDiffApprovals: (...args: unknown[]) => mockResolveAllDiffs(...args),
}))

const mockClearPending = jest.fn()
const mockResetAutoApprove = jest.fn()
let mockQueuedCount = 0
jest.mock('@/stores/permissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      getQueuedCount: () => mockQueuedCount,
      clearPending: mockClearPending,
      resetAutoApprove: mockResetAutoApprove,
    }),
  },
}))

jest.mock('@/services/agent/queueOperationLog', () => ({
  getQueueLogSessionId: () => 'test',
  getQueueLogProjectPath: () => null,
  recordQueueOperation: jest.fn().mockResolvedValue(undefined),
  setQueueLogContext: jest.fn(),
}))

import { stopAgentRun } from '../stopAgentRun'
import {
  enqueue,
  getCommandQueueSnapshot,
  isQueuePaused,
  resetCommandQueue,
} from '../messageQueue'
import { useAgentStore } from '@/stores/agentStore'

beforeEach(() => {
  jest.clearAllMocks()
  mockQueuedCount = 0
  resetCommandQueue()
  useAgentStore.getState().setStatus('generating')
})

describe('stopAgentRun', () => {
  it('kills live work and finalizes the transcript', () => {
    const result = stopAgentRun()

    expect(result).toBe(true)
    expect(mockAbortAll).toHaveBeenCalledTimes(1)
    expect(mockCancelLoop).toHaveBeenCalledTimes(1)
    expect(mockClearPending).toHaveBeenCalledTimes(1)
    expect(mockResolveAllDiffs).toHaveBeenCalledWith(false)
    expect(mockFinalize).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().status).toBe('cancelled')
  })

  it('drops steering, PARKS queued tasks paused', () => {
    enqueue({ value: 'usa a lib X', mode: 'prompt', uuid: 'S1' })
    enqueue({ value: 'faz a feature B', mode: 'prompt', uuid: 'T1', asTask: true })

    stopAgentRun()

    expect(getCommandQueueSnapshot().map(c => c.uuid)).toEqual(['T1'])
    // Parqueada: sem a pausa, o guard idle pós-cancel fazia o drain
    // disparar T1 NO INSTANTE do Stop — "Stop que não pára".
    expect(isQueuePaused()).toBe(true)
  })

  it('steer-only queue empties without leaving a pause behind', () => {
    enqueue({ value: 'só orientação', mode: 'prompt', uuid: 'S1' })

    stopAgentRun()

    expect(getCommandQueueSnapshot()).toHaveLength(0)
    expect(isQueuePaused()).toBe(false)
  })

  it('declining the pending-permissions confirm touches nothing', () => {
    mockQueuedCount = 2
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)
    enqueue({ value: 'tarefa', mode: 'prompt', uuid: 'T1', asTask: true })

    const result = stopAgentRun()

    expect(result).toBe(false)
    expect(mockCancelLoop).not.toHaveBeenCalled()
    expect(getCommandQueueSnapshot()).toHaveLength(1)
    expect(isQueuePaused()).toBe(false)
    confirmSpy.mockRestore()
  })
})
