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
  FileService: { readFile: jest.fn().mockRejectedValue(new Error('not found')) },
}))

jest.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      addSystemMessage: jest.fn(),
      addCardMessage: jest.fn(),
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

import { executePlan } from '../commands/planCommand'

describe('executePlan call sequence', () => {
  beforeEach(() => {
    enablePlanMode.mockReset()
    disablePlanMode.mockReset()
    setRequestType.mockReset()
    setAutoApproveDiffs.mockReset()
    mockRunAgentWithCallbacks.mockReset()
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
    // break the architect's tool-blocklist.
    expect(sysPrompt).toContain('provision_auth')
    expect(sysPrompt).toContain('execute_command')
    expect(sysPrompt).toContain('start_dev_server')
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

  test('user-bubble text is "/plan <args>"', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (_p: string, opts: Record<string, unknown>) => {
      capturedOptions = opts
    })

    await executePlan('xyz', '/projects/foo')

    expect(capturedOptions?.userMessageText).toBe('/plan xyz')
  })

  test('returns early without enablingPlanMode when args are empty', async () => {
    await executePlan('', '/projects/foo')
    expect(enablePlanMode).not.toHaveBeenCalled()
    expect(mockRunAgentWithCallbacks).not.toHaveBeenCalled()
  })

  test('forwards #auth-google requirement into the architect prompt', async () => {
    let capturedPrompt: string | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt
    })

    await executePlan('platform with users registered via #auth-google', '/projects/foo')

    expect(capturedPrompt).toBeDefined()
    // The architect must be told to use TM Code's canonical auth pattern,
    // not a generic auth library invented from scratch.
    expect(capturedPrompt).toContain('Google sign-in')
    expect(capturedPrompt).toContain('provision_auth')
    expect(capturedPrompt).toContain('auth-proxy')
    // Negative: must explicitly tell the architect NOT to suggest passport-google-oauth20
    expect(capturedPrompt).toContain('passport-google-oauth20')
    expect(capturedPrompt).toMatch(/Do NOT propose/i)
  })

  test('forwards #auth-email-password requirement', async () => {
    let capturedPrompt: string | undefined
    mockRunAgentWithCallbacks.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt
    })

    await executePlan('app with #auth-email-password', '/projects/foo')

    expect(capturedPrompt).toContain('email/password sign-in')
    expect(capturedPrompt).toContain('provision_auth')
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
