/**
 * Integration test for /plan — verifies executePlan's call sequence and
 * the prompt it sends.
 *
 * The real ToolExecutor pulls in `import.meta.env` (Vite-only syntax) and
 * full Tauri bindings, neither of which Jest can load. We mock the executor
 * surface at module level so we can verify the wiring without instantiating
 * the singleton. The plan-mode allowlist itself is exercised by
 * planMode.test.ts (pure functions, no mocking required).
 */

const enablePlanMode = jest.fn()
const disablePlanMode = jest.fn()
const setRequestType = jest.fn()
const setAutoApproveDiffs = jest.fn()
const mockRunAgentWithCallbacks = jest.fn()
const mockReadFile = jest.fn().mockRejectedValue(new Error('not found'))
const mockAddSystemMessage = jest.fn()
const mockAddCardMessage = jest.fn()
const mockSetPlanResumePending = jest.fn()
const mockCreateSession = jest.fn()

jest.mock('../agentRunner', () => ({
  runAgentWithCallbacks: (...args: unknown[]) => mockRunAgentWithCallbacks(...args),
}))

jest.mock('../toolExecutor', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      enablePlanMode,
      disablePlanMode,
      isPlanMode: () => true,
    }),
  },
}))

jest.mock('../agentService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ setRequestType }),
  },
}))

jest.mock('../../fileService', () => ({
  FileService: { readFile: mockReadFile },
}))

jest.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      addSystemMessage: mockAddSystemMessage,
      addCardMessage: mockAddCardMessage,
      setPlanResumePending: mockSetPlanResumePending,
      createSession: mockCreateSession,
      activeSessionId: null,
    }),
  },
}))

jest.mock('../../../stores/agentStore', () => ({
  useAgentStore: { getState: () => ({ status: 'idle' }) },
}))

jest.mock('../../../stores/permissionStore', () => ({
  usePermissionStore: {
    getState: () => ({ autoApproveDiffs: false, setAutoApproveDiffs }),
  },
}))

// Settings store — language tests below override agentLanguage at runtime
let mockAgentLanguage: string = 'en'
jest.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ get agentLanguage() { return mockAgentLanguage } }),
  },
}))

import { executePlan, executePlanResume } from '../commands/planCommand'

describe('executePlan call sequence', () => {
  beforeEach(() => {
    enablePlanMode.mockReset()
    disablePlanMode.mockReset()
    setRequestType.mockReset()
    setAutoApproveDiffs.mockReset()
    mockRunAgentWithCallbacks.mockReset()
    mockReadFile.mockReset()
    mockReadFile.mockRejectedValue(new Error('not found'))
    mockAddSystemMessage.mockReset()
    mockAddCardMessage.mockReset()
    mockSetPlanResumePending.mockReset()
    mockCreateSession.mockReset()
    mockAgentLanguage = 'en'
  })

  test('enables planMode BEFORE awaiting the agent loop', async () => {
    let enableOrder = -1
    let runOrder = -1
    let counter = 0

    enablePlanMode.mockImplementation(() => {
      enableOrder = ++counter
    })
    mockRunAgentWithCallbacks.mockImplementation(async () => {
      runOrder = ++counter
    })

    await executePlan('build x', '/projects/foo')

    expect(enableOrder).toBeGreaterThan(0)
    expect(runOrder).toBeGreaterThan(enableOrder)
  })

  test('sets X-Request-Type=plan before the agent loop', async () => {
    const calls: string[] = []
    setRequestType.mockImplementation((t: string | null) => {
      calls.push(t === null ? 'null' : t)
    })
    mockRunAgentWithCallbacks.mockImplementation(async () => {
      calls.push('agent_loop')
    })

    await executePlan('build x', '/projects/foo')

    // Order: setRequestType('plan') → agent_loop → setRequestType(null)
    expect(calls).toEqual(['plan', 'agent_loop', 'null'])
  })

  test('disables planMode after the agent loop completes', async () => {
    mockRunAgentWithCallbacks.mockResolvedValue(undefined)
    await executePlan('build x', '/projects/foo')
    expect(disablePlanMode).toHaveBeenCalledTimes(1)
  })

  test('disables planMode even if the agent loop throws', async () => {
    mockRunAgentWithCallbacks.mockRejectedValue(new Error('boom'))
    await expect(executePlan('build x', '/projects/foo')).rejects.toThrow('boom')
    expect(disablePlanMode).toHaveBeenCalledTimes(1)
  })

  test('passes systemPromptOverride with the architect role', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_p: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('build a todo app', '/projects/foo')

    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.systemPromptOverride).toBeTruthy()
    const sysPrompt = capturedOptions?.systemPromptOverride as string
    // Architect-prompt fingerprints
    expect(sysPrompt).toContain('Software Architect')
    expect(sysPrompt).toContain('PLAN.md')
    expect(sysPrompt).toContain('NOT a coding agent')
    // Forbidden tools listed in the system prompt — names interpolated
    // from toolNames.ts so a rename in the registry does not silently
    // break the architect's tool-blocklist. (MANAGED-PLATFORM cut 2026-07:
    // provision_auth was replaced by delete_file as the destructive example.)
    expect(sysPrompt).toContain('delete_file')
    expect(sysPrompt).toContain('execute_command')
    expect(sysPrompt).toContain('start_dev_server')
    expect(sysPrompt).not.toContain('provision_auth')
  })

  test('passes the user idea verbatim in the prompt', async () => {
    let capturedPrompt: string | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt
    })

    await executePlan('build a real-time chat app with rooms', '/projects/foo')

    expect(capturedPrompt).toContain('build a real-time chat app with rooms')
    expect(capturedPrompt).toContain('/projects/foo/PLAN.md')
  })

  test('creates a feature-specific plan when PLAN.md already exists', async () => {
    let capturedPrompt: string | undefined
    let capturedOptions: Record<string, unknown> | undefined
    let agentRan = false
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/projects/foo/PLAN.md') return 'existing plan'
      if (path === '/projects/foo/PLAN-build-chat-export.md' && agentRan) {
        return 'Status: PENDING APPROVAL\n# Chat export'
      }
      throw new Error('not found')
    })
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string, opts: Record<string, unknown>) => {
      capturedPrompt = prompt
      capturedOptions = opts
      agentRan = true
    })

    await executePlan('build chat export', '/projects/foo')

    expect(enablePlanMode).toHaveBeenCalledWith('PLAN-build-chat-export.md')
    expect(capturedPrompt).toContain('/projects/foo/PLAN-build-chat-export.md')
    expect(capturedOptions?.systemPromptOverride as string).toContain('PLAN-build-chat-export.md')
    expect(mockAddCardMessage).toHaveBeenCalledWith('plan_approval', '/projects/foo', {
      planPath: '/projects/foo/PLAN-build-chat-export.md',
      planFileName: 'PLAN-build-chat-export.md',
    })
  })

  test('keeps resume metadata when PLAN.md is still DRAFT after an interrupted run', async () => {
    let readCount = 0
    mockReadFile.mockImplementation(async () => {
      readCount += 1
      if (readCount === 1) throw new Error('not found')
      return 'Status: DRAFT\n# Architecture'
    })
    mockRunAgentWithCallbacks.mockResolvedValue(undefined)

    await executePlan('build inventory', '/projects/foo')

    expect(mockSetPlanResumePending).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/projects/foo',
      originalArgs: 'build inventory',
      planPath: '/projects/foo/PLAN.md',
      planFileName: 'PLAN.md',
    }))
    expect(mockSetPlanResumePending).not.toHaveBeenCalledWith(null)
    expect(mockAddSystemMessage).toHaveBeenCalled()
  })

  test('clears resume metadata when PLAN.md is ready for approval', async () => {
    let readCount = 0
    mockReadFile.mockImplementation(async () => {
      readCount += 1
      if (readCount === 1) throw new Error('not found')
      return 'Status: PENDING APPROVAL\n# Architecture'
    })
    mockRunAgentWithCallbacks.mockResolvedValue(undefined)

    await executePlan('build inventory', '/projects/foo')

    expect(mockSetPlanResumePending).toHaveBeenLastCalledWith(null)
    expect(mockAddCardMessage).toHaveBeenCalledWith('plan_approval', '/projects/foo', {
      planPath: '/projects/foo/PLAN.md',
      planFileName: 'PLAN.md',
    })
  })

  test('user-bubble text is "/plan <args>"', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_p: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('xyz', '/projects/foo')

    expect(capturedOptions?.userMessageText).toBe('/plan xyz')
  })

  test('uses free-form planning by default', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_prompt: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('build anything with any backend', '/projects/foo')

    expect(capturedOptions?.cmdOnlyMode).toBe(true)
    const sysPrompt = capturedOptions?.systemPromptOverride as string
    expect(sysPrompt).toContain('Stack choice — free, with explicit trade-offs')
    expect(sysPrompt).toContain('There are NO')
    expect(sysPrompt).toContain('dependencies or deploy artefacts')
    expect(sysPrompt).not.toContain('Stack baseline (the parts the architect still chooses)')
  })

  test('resume continues the interrupted plan with architect prompt and same artefact', async () => {
    let capturedPrompt: string | undefined
    let capturedOptions: Record<string, unknown> | undefined
    let readCount = 0
    mockReadFile.mockImplementation(async () => {
      readCount += 1
      if (readCount === 1) return 'Status: DRAFT\n## 1. Context\n_In progress._'
      return 'Status: PENDING APPROVAL\n# Architecture'
    })
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string, opts: Record<string, unknown>) => {
      capturedPrompt = prompt
      capturedOptions = opts
    })

    await executePlanResume('prossegue', {
      projectPath: '/projects/foo',
      originalArgs: 'build inventory',
      planPath: '/projects/foo/PLAN.md',
      planFileName: 'PLAN.md',
      updatedAt: 123,
    })

    expect(enablePlanMode).toHaveBeenCalledWith('PLAN.md')
    expect(capturedPrompt).toContain('Resume an interrupted /plan architect run')
    expect(capturedPrompt).toContain('build inventory')
    expect(capturedPrompt).toContain('Status: DRAFT')
    expect(capturedOptions?.userMessageText).toBe('prossegue')
    expect(capturedOptions?.systemPromptOverride as string).toContain('Software Architect')
    expect(capturedOptions?.cmdOnlyMode).toBe(true)
    expect(mockSetPlanResumePending).toHaveBeenLastCalledWith(null)
  })

  test('resume sends attachments to the model without storing the internal prompt as user blocks', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    const attachment = {
      id: 'att-1',
      type: 'file',
      name: 'notes.md',
      path: '/projects/foo/notes.md',
    }
    const userBlocks = [
      { type: 'text', text: 'usa estas notas' },
      { type: 'attachment', attachment },
    ]
    mockReadFile.mockImplementation(async () => 'Status: DRAFT\n# Architecture')
    mockRunAgentWithCallbacks.mockImplementation(async (_prompt: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlanResume('usa estas notas', {
      projectPath: '/projects/foo',
      originalArgs: 'build inventory',
      planPath: '/projects/foo/PLAN.md',
      planFileName: 'PLAN.md',
      updatedAt: 123,
    }, [attachment as never], userBlocks as never)

    expect(capturedOptions?.userMessageBlocks).toBe(userBlocks)
    expect(capturedOptions?.cmdOnlyMode).toBe(true)
    const modelBlocks = capturedOptions?.modelMessageBlocks as Array<{ type: string; text?: string; attachment?: unknown }>
    expect(modelBlocks[0]?.type).toBe('text')
    expect(modelBlocks[0]?.text).toContain('Resume an interrupted /plan architect run')
    expect(modelBlocks[1]).toEqual({ type: 'attachment', attachment })
  })

  test('returns early without enablingPlanMode when args are empty', async () => {
    await executePlan('', '/projects/foo')
    expect(enablePlanMode).not.toHaveBeenCalled()
    expect(mockRunAgentWithCallbacks).not.toHaveBeenCalled()
  })

  // NOTE (2026-07): the 'forwards #auth-google requirement' and 'forwards
  // #auth-email-password requirement' tests were removed with the
  // MANAGED-PLATFORM layer — the architect no longer receives a managed-auth
  // platform block (provision_auth / auth-proxy); those hashtags now pass
  // through to the user idea as plain text. The test below asserts that.

  test('the removed #auth-* tags no longer produce a platform-auth block', async () => {
    let capturedPrompt: string | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt
    })

    await executePlan('platform with users registered via #auth-google', '/projects/foo')

    expect(capturedPrompt).toBeDefined()
    // The idea text (with the now-unrecognised tag) is forwarded verbatim…
    expect(capturedPrompt).toContain('platform with users registered via #auth-google')
    // …and no managed-auth guidance is injected.
    expect(capturedPrompt).not.toContain('provision_auth')
    expect(capturedPrompt).not.toContain('auth-proxy')
  })

  test('forwards #design requirement', async () => {
    let capturedPrompt: string | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt
    })

    await executePlan('landing page with #design', '/projects/foo')

    expect(capturedPrompt).toContain('Design:')
    expect(capturedPrompt).toContain('design')
  })

  test('skips platform-requirements block when no hashtags present', async () => {
    let capturedPrompt: string | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt
    })

    await executePlan('plain todo app', '/projects/foo')

    expect(capturedPrompt).not.toContain('Platform requirements')
    expect(capturedPrompt).not.toContain('provision_auth')
  })

  test('respects agentLanguage from settings — Portuguese forwarded into the architect system prompt', async () => {
    mockAgentLanguage = 'pt'
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_p: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('build a thing', '/projects/foo')

    const sysPrompt = capturedOptions?.systemPromptOverride as string
    expect(sysPrompt).toContain('LANGUAGE: Always respond in Portuguese')
    // Code identifiers stay native — same contract as the standard
    // getLangInstruction directive in contextBuilder.
    expect(sysPrompt).toContain('Code identifiers')
  })

  test('English agentLanguage forwards an English directive (not the multi-lang variant)', async () => {
    mockAgentLanguage = 'en'
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_p: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('build a thing', '/projects/foo')

    const sysPrompt = capturedOptions?.systemPromptOverride as string
    expect(sysPrompt).toContain('LANGUAGE: Respond in English')
    expect(sysPrompt).not.toContain('Always respond in Portuguese')
  })

  test('falls back to English when settingsStore is not hydrated', async () => {
    // Simulate the early-boot path where the store throws on getState().
    const original = mockAgentLanguage
    mockAgentLanguage = '' // empty falsy → falls through to 'en' default
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_p: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('build a thing', '/projects/foo')

    const sysPrompt = capturedOptions?.systemPromptOverride as string
    expect(sysPrompt).toContain('LANGUAGE: Respond in English')
    mockAgentLanguage = original
  })
})
