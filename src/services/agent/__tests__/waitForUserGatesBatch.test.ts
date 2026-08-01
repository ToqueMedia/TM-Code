/**
 * Gate de diffs ciente do lote (plano iron-valley-widgeon, Parte 1.3):
 * waitForUserGates deixa passar os writes do lote ativo (os diffs acumulam na
 * barra de aprovação e são decididos juntos), mas continua a bloquear
 * qualquer tool fora do lote e tudo quando há um diff pendente de um lote já
 * terminado (turno anterior / outro run).
 */

import { TextEncoder } from 'util'

if (!globalThis.TextEncoder) {
  Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder })
}

// ═══ Module-level mocks (before imports) ═══

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (cmd: string) => {
    if (cmd === 'get_home_directory') return Promise.resolve('/Users/test')
    return Promise.resolve(undefined)
  },
}))

jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn().mockResolvedValue(() => {}),
}))

jest.mock('@/stores/permissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      pendingPermission: null,
      permissionQueue: [],
      requestPermission: jest.fn(),
      requestPathAccess: jest.fn().mockResolvedValue({ approved: false, prompted: true, source: 'user' }),
      autoApproveDiffs: false,
      additionalDirectories: [],
    }),
  },
}))
jest.mock('@/stores/projectStore', () => ({
  useProjectStore: { getState: () => ({ currentProject: { path: '/projects/test-app' } }) },
}))
jest.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ agentLanguage: 'en', flaggedCommands: [] }) },
}))
jest.mock('@/stores/fileTreeStore', () => ({
  useFileTreeRepository: { getState: () => ({ refresh: jest.fn() }) },
}))
jest.mock('@/stores/editorStore', () => ({
  useEditorRepository: { getState: () => ({ openFiles: [], closeFile: jest.fn() }) },
}))
jest.mock('@/stores/checkpointStore', () => ({
  useCheckpointStore: { getState: () => ({ syncFromService: jest.fn() }) },
}))
jest.mock('@/stores/layoutStore', () => ({
  useLayoutStore: { getState: () => ({ devServer: null }) },
}))
jest.mock('@/stores/askUserQuestionStore', () => ({
  useAskUserQuestionStore: { getState: () => ({ pending: new Map() }) },
}))
jest.mock('@/stores/credentialRequestStore', () => ({
  useCredentialRequestStore: { getState: () => ({ pending: new Map() }) },
}))

// O gate lê os pendentes de diff via named exports do chatStore — o teste
// controla-os diretamente.
const mockHasPendingDiffApprovals = jest.fn((): boolean => false)
const mockGetPendingDiffApprovalToolIds = jest.fn((): string[] => [])
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      recordToolPermission: jest.fn(),
      updateToolCallProgress: jest.fn(),
      tasks: [],
    }),
    setState: jest.fn(),
  },
  appendTextDeltaBuffered: jest.fn(),
  appendReasoningDeltaBuffered: jest.fn(),
  hasPendingDiffApprovals: () => mockHasPendingDiffApprovals(),
  getPendingDiffApprovalToolIds: () => mockGetPendingDiffApprovalToolIds(),
}))

jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken: jest.fn().mockResolvedValue('mock-token') }) },
}))
jest.mock('../../devServerManager', () => ({
  devServerManager: { start: jest.fn(), stop: jest.fn(), getStatus: jest.fn() },
}))
jest.mock('../skillService', () => ({}))
jest.mock('../../mcp/mcpService', () => ({}))
jest.mock('../../fsVersion', () => ({ bumpFsVersion: jest.fn().mockResolvedValue(undefined), getFsVersion: jest.fn().mockReturnValue(0) }))
jest.mock('../../analytics', () => ({ trackEvent: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../../utils/errors', () => ({ formatError: (err: unknown) => err instanceof Error ? err.message : String(err) }))
jest.mock('../../browserSessionManager', () => ({ browserSession: { beginSession: jest.fn().mockResolvedValue(undefined) } }))

// ═══ Imports ═══

import ToolExecutor from '../toolExecutor'
import { beginWriteBatch, endWriteBatch } from '../writeBatch'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type GateAccess = { waitForUserGates(signal?: AbortSignal, toolUseId?: string): Promise<void> }

function freshExecutor(): GateAccess {
  // @ts-expect-error — reset private singleton for test isolation
  ToolExecutor.instance = undefined
  return ToolExecutor.getInstance() as unknown as GateAccess
}

/** Corre o gate e devolve um probe de resolução (o gate faz poll a 120ms). */
function probeGate(exec: GateAccess, toolUseId?: string) {
  let resolved = false
  const promise = exec.waitForUserGates(undefined, toolUseId).then(() => { resolved = true })
  return { promise, isResolved: () => resolved }
}

describe('waitForUserGates — lote de writes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasPendingDiffApprovals.mockReturnValue(false)
    mockGetPendingDiffApprovalToolIds.mockReturnValue([])
    endWriteBatch()
  })

  afterEach(() => {
    endWriteBatch()
  })

  it('membro do lote atravessa o gate com todos os pendentes dentro do lote', async () => {
    beginWriteBatch(['t1', 't2', 't3'])
    mockHasPendingDiffApprovals.mockReturnValue(true)
    mockGetPendingDiffApprovalToolIds.mockReturnValue(['t1', 't2'])

    const { promise, isResolved } = probeGate(freshExecutor(), 't3')
    await sleep(20)
    expect(isResolved()).toBe(true)
    await promise
  })

  it('tool fora do lote bloqueia até os diffs resolverem', async () => {
    beginWriteBatch(['t1', 't2'])
    mockHasPendingDiffApprovals.mockReturnValue(true)
    mockGetPendingDiffApprovalToolIds.mockReturnValue(['t1'])

    const { promise, isResolved } = probeGate(freshExecutor(), 't9')
    await sleep(300)
    expect(isResolved()).toBe(false)

    // Utilizador decide os diffs → gate abre no próximo tick.
    mockHasPendingDiffApprovals.mockReturnValue(false)
    mockGetPendingDiffApprovalToolIds.mockReturnValue([])
    await promise
    expect(isResolved()).toBe(true)
  })

  it('diff pendente de um lote já terminado bloqueia tudo (mesmo o próprio id)', async () => {
    // Lote fechado (endWriteBatch já correu), mas o diff continua por decidir
    // — cenário do turno seguinte a arrancar antes de o utilizador decidir.
    mockHasPendingDiffApprovals.mockReturnValue(true)
    mockGetPendingDiffApprovalToolIds.mockReturnValue(['t1'])

    const { promise, isResolved } = probeGate(freshExecutor(), 't1')
    await sleep(300)
    expect(isResolved()).toBe(false)

    mockHasPendingDiffApprovals.mockReturnValue(false)
    await promise
    expect(isResolved()).toBe(true)
  })

  it('pendente FORA do lote bloqueia até um membro do lote (turno anterior por decidir)', async () => {
    beginWriteBatch(['t2'])
    mockHasPendingDiffApprovals.mockReturnValue(true)
    // t-old não pertence ao lote ativo → stray → bloqueia até resolver.
    mockGetPendingDiffApprovalToolIds.mockReturnValue(['t-old'])

    const { promise, isResolved } = probeGate(freshExecutor(), 't2')
    await sleep(300)
    expect(isResolved()).toBe(false)

    mockGetPendingDiffApprovalToolIds.mockReturnValue([])
    mockHasPendingDiffApprovals.mockReturnValue(false)
    await promise
    expect(isResolved()).toBe(true)
  })
})
