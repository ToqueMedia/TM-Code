/**
 * Tests for the dynamic toolset selector.
 *
 * Covers: CORE starting set, keyword expansion, request_tools meta-tool,
 * monotonic expansion (never retracts), and the request_tools bridge result.
 */

import {
  ToolsetSelector,
  REQUEST_TOOLS_NAME,
  CORE_TOOLS,
} from '../toolsetSelector'
import {
  SEARCH_FILES, READ_FILE, READ_LARGE_RESULT, EDIT_FILE,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
  WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  LIST_DIRECTORY, GLOB, READ_SKILL,
  EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER, READ_DEV_SERVER_LOGS,
  WEB_FETCH,
  DELEGATE, COLLECT_RESULTS,
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY,
  PROVISION_AUTH, PROVISION_DATABASE, PROVISION_FILES, PROVISION_DEPLOY,
  REQUEST_CREDENTIALS,
} from '../toolNames'
import type OpenAI from 'openai'

// All 36 tool names in the registry.
const ALL_NAMES = [
  SEARCH_FILES, READ_FILE, READ_LARGE_RESULT, EDIT_FILE,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
  WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  LIST_DIRECTORY, GLOB, READ_SKILL,
  EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER, READ_DEV_SERVER_LOGS,
  WEB_FETCH,
  DELEGATE, COLLECT_RESULTS,
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY,
  PROVISION_AUTH, PROVISION_DATABASE, PROVISION_FILES, PROVISION_DEPLOY,
  REQUEST_CREDENTIALS,
]

/** Build a minimal OpenAI tool definition array for the given names. */
function makeTools(names: string[]): OpenAI.ChatCompletionTool[] {
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: `tool ${name}`, parameters: { type: 'object' as const, properties: {} } },
  }))
}

const ALL_TOOLS = makeTools(ALL_NAMES)

describe('ToolsetSelector', () => {
  it('starts with the CORE minimal toolset', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    const { tools, activeCount, totalCount, allActive } = selector.selectForTurn(ALL_TOOLS, 'fix a typo')
    // CORE tools only (+ request_tools meta-tool since not all are active).
    const toolNames = tools.map((t) => t.function.name)
    for (const core of CORE_TOOLS) {
      expect(toolNames).toContain(core)
    }
    expect(activeCount).toBe(CORE_TOOLS.length)
    expect(totalCount).toBe(ALL_NAMES.length)
    expect(allActive).toBe(false)
    // request_tools meta-tool is injected when not all tools are active.
    expect(toolNames).toContain(REQUEST_TOOLS_NAME)
  })

  it('reduces a simple bugfix from 36 tools to CORE + request_tools', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    const { tools, activeCount } = selector.selectForTurn(ALL_TOOLS, 'fix a typo in utils.ts')
    // CORE (7) + request_tools (1) = 8 tool definitions sent.
    expect(tools.length).toBe(CORE_TOOLS.length + 1)
    expect(activeCount).toBe(CORE_TOOLS.length)
    // ~28 tools NOT sent — that's the savings.
    expect(ALL_NAMES.length - activeCount).toBe(ALL_NAMES.length - CORE_TOOLS.length)
  })

  it('expands FILE_OPS on "create new file" keyword', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    const { activeCount } = selector.selectForTurn(ALL_TOOLS, 'create a new file called config.ts')
    // CORE + FILE_OPS group activated.
    expect(activeCount).toBeGreaterThan(CORE_TOOLS.length)
    expect(selector.isActive(WRITE_FILE)).toBe(true)
    expect(selector.isActive(CREATE_FILE)).toBe(true)
  })

  it('expands PROVISION + SHELL on "deploy" keyword', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    selector.selectForTurn(ALL_TOOLS, 'deploy the app to production')
    expect(selector.isActive(PROVISION_DEPLOY)).toBe(true)
    expect(selector.isActive(START_DEV_SERVER)).toBe(true)
  })

  it('expands MEMORY on "remember" keyword', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    selector.selectForTurn(ALL_TOOLS, 'remember that the user prefers tabs')
    expect(selector.isActive(SAVE_MEMORY)).toBe(true)
  })

  it('expands PROVISION on "auth" / "login" keyword', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    selector.selectForTurn(ALL_TOOLS, 'add login with google')
    expect(selector.isActive(PROVISION_AUTH)).toBe(true)
  })

  it('expands WEB + SUBAGENT on "research web" keyword', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    selector.selectForTurn(ALL_TOOLS, 'research the API docs online')
    expect(selector.isActive(WEB_FETCH)).toBe(true)
    expect(selector.isActive(DELEGATE)).toBe(true)
  })

  it('requestTools() activates named tools and reports unknowns', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    const result = selector.requestTools([WRITE_FILE, CREATE_FILE, 'nonexistent_tool'])
    expect(result.added).toEqual(expect.arrayContaining([WRITE_FILE, CREATE_FILE]))
    expect(result.unknown).toEqual(['nonexistent_tool'])
    expect(selector.isActive(WRITE_FILE)).toBe(true)
  })

  it('requestTools() reports already-active tools', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    const result = selector.requestTools([SEARCH_FILES]) // already in CORE
    expect(result.alreadyActive).toEqual([SEARCH_FILES])
    expect(result.added).toEqual([])
  })

  it('expands monotonically — once active, a tool never leaves', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    // Turn 1: expand with "deploy".
    selector.selectForTurn(ALL_TOOLS, 'deploy the app')
    expect(selector.isActive(PROVISION_DEPLOY)).toBe(true)
    // Turn 2: a simple message with no triggers — PROVISION_DEPLOY stays.
    selector.selectForTurn(ALL_TOOLS, 'now fix a typo')
    expect(selector.isActive(PROVISION_DEPLOY)).toBe(true)
  })

  it('omits request_tools meta-tool when ALL tools are active', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    // Activate everything.
    selector.requestTools(ALL_NAMES)
    const { tools, allActive } = selector.selectForTurn(ALL_TOOLS, 'do something')
    expect(allActive).toBe(true)
    expect(tools.map((t) => t.function.name)).not.toContain(REQUEST_TOOLS_NAME)
    expect(tools.length).toBe(ALL_NAMES.length)
  })

  it('expandForToolName() activates a single tool defensively', () => {
    const selector = new ToolsetSelector(ALL_NAMES)
    const added = selector.expandForToolName(WRITE_FILE)
    expect(added).toBe(true)
    expect(selector.isActive(WRITE_FILE)).toBe(true)
    // Second call is a no-op.
    expect(selector.expandForToolName(WRITE_FILE)).toBe(false)
    // Unknown tool name is a no-op.
    expect(selector.expandForToolName('nonexistent')).toBe(false)
  })

  it('only activates tools that exist in the registry', () => {
    // Registry with only CORE tools — FILE_OPS names shouldn't activate.
    const selector = new ToolsetSelector([...CORE_TOOLS])
    selector.selectForTurn(ALL_TOOLS, 'create a new file')
    // WRITE_FILE is not in this limited registry, so it can't be active.
    expect(selector.isActive(WRITE_FILE)).toBe(false)
  })
})
