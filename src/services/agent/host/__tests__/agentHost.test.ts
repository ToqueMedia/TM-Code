/**
 * AgentHost (P2 do headless) — o critério de aceitação da fase: as quatro
 * esperas por decisão humana respondem por um hospedeiro SEM React nem DOM.
 *
 * Duas direcções:
 *  1. hospedeiro guiado por script (setAgentHost) — a via headless/teste;
 *  2. o default-janela delega nas stores exactamente como os call sites
 *     faziam inline (stores mockadas; nenhum componente React envolvido).
 */

import type { PermissionDecision } from '@/stores/permissionStore'
import { getAgentHost, setAgentHost, type AgentHost } from '../agentHost'

jest.mock('@/stores/permissionStore', () => {
  const requestPermission = jest.fn(async () => ({ approved: true }))
  const requestPathAccess = jest.fn(async () => ({ approved: false, denyReason: 'fora do scope' }))
  return {
    usePermissionStore: {
      getState: () => ({
        requestPermission,
        requestPathAccess,
        pendingPermission: null,
        permissionQueue: [],
      }),
    },
    __permMocks: { requestPermission, requestPathAccess },
  }
})

jest.mock('@/stores/chatStore', () => {
  const createDiffApprovalPromise = jest.fn(async () => true)
  return {
    createDiffApprovalPromise,
    hasPendingDiffApprovals: () => false,
    getPendingDiffApprovalToolIds: () => [],
    useChatStore: { getState: () => ({}) },
    __chatMocks: { createDiffApprovalPromise },
  }
})

jest.mock('@/stores/askUserQuestionStore', () => ({
  useAskUserQuestionStore: { getState: () => ({ pending: new Map() }) },
}))

jest.mock('@/stores/credentialRequestStore', () => ({
  useCredentialRequestStore: { getState: () => ({ pending: new Map() }) },
}))

const { __permMocks } = jest.requireMock('@/stores/permissionStore') as {
  __permMocks: { requestPermission: jest.Mock; requestPathAccess: jest.Mock }
}
const { __chatMocks } = jest.requireMock('@/stores/chatStore') as {
  __chatMocks: { createDiffApprovalPromise: jest.Mock }
}

afterEach(() => {
  setAgentHost(null)
  jest.clearAllMocks()
})

describe('registry', () => {
  it('setAgentHost instala um hospedeiro; null repõe o default-janela', async () => {
    const scripted: AgentHost = {
      canUseTool: jest.fn(async () =>
        ({ approved: false, denyReason: 'headless policy' } as unknown as PermissionDecision)),
      requestPathAccess: jest.fn(async () =>
        ({ approved: true } as unknown as PermissionDecision)),
      approveDiff: jest.fn(async () => true),
      requestCredentials: jest.fn(async () => ({ submitted: false })),
      askUserQuestion: jest.fn(async () => ({})),
      waitForUserGates: jest.fn(async () => undefined),
    }
    setAgentHost(scripted)
    expect(getAgentHost()).toBe(scripted)
    setAgentHost(null)
    expect(getAgentHost()).not.toBe(scripted)
  })
})

describe('hospedeiro guiado por script responde às 4 vias sem React', () => {
  it('permissão negada, diff aprovado, credenciais cancelas, pergunta respondida', async () => {
    const scripted: AgentHost = {
      canUseTool: jest.fn(async () =>
        ({ approved: false, denyReason: 'headless: escrita bloqueada' } as unknown as PermissionDecision)),
      requestPathAccess: jest.fn(async () =>
        ({ approved: true } as unknown as PermissionDecision)),
      approveDiff: jest.fn(async () => true),
      requestCredentials: jest.fn(async () => ({ submitted: false })),
      askUserQuestion: jest.fn(async () => ({ question_0: 'Opção A' })),
      waitForUserGates: jest.fn(async () => undefined),
    }
    setAgentHost(scripted)
    const host = getAgentHost()

    const perm = await host.canUseTool('write_file', { file_path: 'x.ts' })
    expect(perm.approved).toBe(false)
    expect(await host.approveDiff('tc-1')).toBe(true)
    expect(await host.requestCredentials({
      serviceName: 'Stripe', fields: [], projectRoot: '/p', taskOrigin: null,
    })).toEqual({ submitted: false })
    expect(await host.askUserQuestion({
      questions: [], projectRoot: '/p', taskOrigin: null,
    })).toEqual({ question_0: 'Opção A' })
    await expect(host.waitForUserGates({ projectId: null, taskId: null })).resolves.toBeUndefined()
  })
})

describe('default-janela delega nas stores (sem componentes React)', () => {
  it('canUseTool → permissionStore.requestPermission com os mesmos args', async () => {
    const decision = await getAgentHost().canUseTool(
      'execute_command', { command: 'rm -rf x' }, 'dangerous_command',
    )
    expect(decision.approved).toBe(true)
    expect(__permMocks.requestPermission).toHaveBeenCalledWith(
      'execute_command', { command: 'rm -rf x' }, 'dangerous_command',
    )
  })

  it('requestPathAccess → permissionStore.requestPathAccess (com projectId)', async () => {
    const decision = await getAgentHost().requestPathAccess('/fora/a.txt', '/fora', 'proj-1')
    expect(decision.approved).toBe(false)
    expect(__permMocks.requestPathAccess).toHaveBeenCalledWith('/fora/a.txt', '/fora', 'proj-1')
  })

  it('approveDiff → chatStore.createDiffApprovalPromise', async () => {
    await expect(getAgentHost().approveDiff('tc-9')).resolves.toBe(true)
    expect(__chatMocks.createDiffApprovalPromise).toHaveBeenCalledWith('tc-9')
  })

  it('waitForUserGates resolve de imediato sem gates pendentes', async () => {
    await expect(
      getAgentHost().waitForUserGates({ projectId: null, taskId: null }),
    ).resolves.toBeUndefined()
  })
})
