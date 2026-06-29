/**
 * Tests for the delegate tool — alias normalization, validation, and error
 * reporting. Ensures delegate({ member: "Research" }) resolves correctly
 * instead of returning "unknown sub-agent type 'undefined'".
 */

import { TextEncoder } from 'util'

if (!globalThis.TextEncoder) {
  Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder })
}

// ═══ Module-level mocks (before imports) ═══

// Mock invoke (toolExecutor imports from invokeMetrics)
const mockInvokeImpl = jest.fn()
jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (cmd: string, ...rest: unknown[]) => {
    if (cmd === 'get_home_directory') return Promise.resolve('/Users/test')
    return mockInvokeImpl(cmd, rest[0])
  },
}))

// Mock listen
jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn().mockResolvedValue(() => {}),
}))

// Mock stores — prevents the Tauri import chain (projectStore → windowService → @tauri-apps/api)
jest.mock('@/stores/permissionStore', () => ({
  usePermissionStore: { getState: () => ({ requestPermission: jest.fn(), requestPathAccess: jest.fn().mockResolvedValue({ approved: false, prompted: true, source: 'user' }), autoApproveDiffs: false, additionalDirectories: [] }) },
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
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      recordToolPermission: jest.fn(),
      updateToolCallProgress: jest.fn(),
      tasks: [],
      activeSessionId: 'test-session',
      sessions: new Map([['test-session', { id: 'test-session', messages: [] }]]),
    }),
    setState: jest.fn(),
    appendTextDeltaBuffered: jest.fn(),
    appendReasoningDeltaBuffered: jest.fn(),
  },
}))

// Mock sub-agent infrastructure
const mockStartRun = jest.fn().mockResolvedValue('sub-agent started')
const mockGetAgentDefinition = jest.fn()
jest.mock('../subAgents/builtInAgents', () => ({
  getAgentDefinition: (type: string) => mockGetAgentDefinition(type),
}))

// Mock sub-agent runner
jest.mock('../subAgents/subAgentRunner', () => ({
  runSubAgent: (...args: unknown[]) => mockStartRun(...args),
}))

// Mock auth + dev server (prevents import.meta.env + Tauri chains)
jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken: jest.fn().mockResolvedValue('mock-token') }) },
}))
jest.mock('../../devServerManager', () => ({
  devServerManager: { start: jest.fn(), stop: jest.fn(), getStatus: jest.fn() },
}))
jest.mock('../skillService', () => ({ PUBLISHING_SKILL_NAME: 'publish-backend' }))
jest.mock('../../mcp/mcpService', () => ({}))
jest.mock('../../fsVersion', () => ({ bumpFsVersion: jest.fn().mockResolvedValue(undefined), getFsVersion: jest.fn().mockReturnValue(0) }))
jest.mock('../../scaffoldingDetector', () => ({ invalidateScaffoldingCache: jest.fn() }))
jest.mock('../../analytics', () => ({ trackEvent: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../../utils/errors', () => ({ formatError: (err: unknown) => err instanceof Error ? err.message : String(err) }))
jest.mock('../../browserSessionManager', () => ({ browserSession: { beginSession: jest.fn().mockResolvedValue(undefined) } }))

// ═══ Imports ═══

import ToolExecutor from '../toolExecutor'

// Helper: execute delegate with given input, catching errors (mirrors the
// bridge: success → string, failure → thrown Error → isError=true)
async function executeDelegate(input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const exec = ToolExecutor.getInstance()
  try {
    const result = await exec.execute('delegate', input, 'test-call-id', new AbortController().signal)
    return { content: typeof result === 'string' ? result : JSON.stringify(result), isError: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: msg, isError: true }
  }
}

// ═══ Tests ═══

describe('delegate tool — alias normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAgentDefinition.mockImplementation((type: string) => ({
      type,
      tools: new Set(['read_file', 'search_files']),
      disallowedTools: new Set(),
      startRun: mockStartRun,
    }))
  })

  it('resolves member: "Research" to the Research sub-agent (not undefined)', async () => {
    // REGRESSION TEST: the model sent `member` instead of `subagent_type`,
    // and the old code read `input.subagent_type` → undefined → "Blocked".
    const result = await executeDelegate({
      member: 'Research',
      description: 'find API docs',
      prompt: 'find the auth shape',
    })

    expect(result.isError).toBe(false)
    expect(mockGetAgentDefinition).toHaveBeenCalledWith('Research')
    expect(mockStartRun).toHaveBeenCalled()
  })

  it('resolves subagent_type: "Explore" (canonical field)', async () => {
    const result = await executeDelegate({
      subagent_type: 'Explore',
      description: 'find usages',
      prompt: 'find all imports of Z',
    })

    expect(result.isError).toBe(false)
    expect(mockGetAgentDefinition).toHaveBeenCalledWith('Explore')
  })

  it('resolves member case-insensitively (member: "research")', async () => {
    const result = await executeDelegate({
      member: 'research',
      description: 'find docs',
      prompt: 'find the API docs',
    })

    expect(result.isError).toBe(false)
    expect(mockGetAgentDefinition).toHaveBeenCalledWith('Research')
  })

  it('resolves type alias', async () => {
    const result = await executeDelegate({
      type: 'Verify',
      description: 'verify changes',
      prompt: 'check the build passes',
    })

    expect(result.isError).toBe(false)
    expect(mockGetAgentDefinition).toHaveBeenCalledWith('Verify')
  })

  it('resolves team_member + task aliases from exported sessions', async () => {
    const result = await executeDelegate({
      team_member: 'Research',
      task: 'Search online for the provider docs.',
    })

    expect(result.isError).toBe(false)
    expect(mockGetAgentDefinition).toHaveBeenCalledWith('Research')
    expect(mockStartRun).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Search online for the provider docs.',
      description: 'Search online for the provider',
    }))
  })

  it('resolves agentType alias', async () => {
    const result = await executeDelegate({
      agentType: 'Explore',
      description: 'search',
      prompt: 'find all tests',
    })

    expect(result.isError).toBe(false)
    expect(mockGetAgentDefinition).toHaveBeenCalledWith('Explore')
  })
})

describe('delegate tool — error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns isError=true when member is missing entirely', async () => {
    const result = await executeDelegate({
      description: 'no member',
      prompt: 'do something',
    })

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content)
    expect(parsed.status).toBe('blocked')
    expect(parsed.availableMembers).toEqual(['Explore', 'Research', 'Verify'])
  })

  it('returns isError=true when member is unknown', async () => {
    const result = await executeDelegate({
      member: 'InvalidAgent',
      description: 'bad member',
      prompt: 'do something',
    })

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content)
    expect(parsed.status).toBe('blocked')
    expect(parsed.reason).toContain('InvalidAgent')
    expect(parsed.availableMembers).toEqual(['Explore', 'Research', 'Verify'])
  })

  it('returns isError=true when prompt/task is missing', async () => {
    const result = await executeDelegate({
      member: 'Research',
      description: 'missing prompt',
    })

    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content)
    expect(parsed.status).toBe('blocked')
    expect(parsed.reason).toContain('No task prompt specified')
  })

  it('does NOT return "Blocked..." as completed/isError=false', async () => {
    const result = await executeDelegate({
      member: 'NonExistent',
      description: 'test',
      prompt: 'test',
    })

    // The old bug: returned a plain string "Blocked: unknown..." with isError=false.
    // The fix: throws, which the bridge catches → isError=true.
    expect(result.isError).toBe(true)
    expect(result.content).not.toBe('Blocked: unknown sub-agent type \'undefined\'. Available: Explore, Research, Verify.')
  })

  it('returns isError=true when sub-agent startup fails', async () => {
    mockGetAgentDefinition.mockImplementation((type: string) => ({
      type,
      tools: new Set(['read_file', 'search_files']),
      disallowedTools: new Set(),
    }))
    mockStartRun.mockRejectedValueOnce(new Error('Maximum concurrent sub-agents reached (4)'))

    const result = await executeDelegate({
      member: 'Research',
      prompt: 'find docs',
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Failed to start Research sub-agent')
  })
})

describe('delegate tool — telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAgentDefinition.mockImplementation((type: string) => ({
      type,
      tools: new Set(['read_file', 'search_files']),
      disallowedTools: new Set(),
      startRun: mockStartRun,
    }))
  })

  it('populates lastDelegateInfo on successful resolution', async () => {
    const exec = ToolExecutor.getInstance()
    exec.clearDelegateTelemetry()
    await executeDelegate({
      member: 'Research',
      description: 'find docs',
      prompt: 'find the API docs',
    })

    expect(exec.consumeDelegateTelemetry()).toMatchObject({
      requestedMember: 'Research',
      resolvedMember: 'Research',
      blocked: false,
      blockedReason: null,
      inputSchemaVersion: 'v2-aliases',
      recoveryAttempted: false,
    })
    expect(exec.consumeDelegateTelemetry()).toBeNull()
  })

  it('populates lastDelegateInfo on blocked resolution', async () => {
    const exec = ToolExecutor.getInstance()
    exec.clearDelegateTelemetry()
    await executeDelegate({
      member: 'InvalidMember',
      description: 'test',
      prompt: 'test',
    })

    expect(exec.consumeDelegateTelemetry()).toMatchObject({
      requestedMember: 'InvalidMember',
      resolvedMember: null,
      blocked: true,
      blockedReason: "Unknown member 'InvalidMember'",
    })
    expect(exec.consumeDelegateTelemetry()).toBeNull()
  })
})
