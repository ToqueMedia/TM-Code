/**
 * Tests for the dynamic toolset selector (profile-bound, Phase 1).
 *
 * The selector now seeds its active set from the Intent Router's PromptProfile
 * (bugfix_local/analysis_readonly/deploy_publish/…) and BOUNDS request_tools +
 * model-planned groups to the profile's `allowed` set. These tests prove:
 *   - bugfix_local starts at ~6 tools and refuses destructive/provision/shell
 *   - analysis_readonly is hard read-only (no edit_file even via request_tools)
 *   - deploy_publish starts with provision/shell from the model-selected profile
 *   - request_tools reports `denied` for tools outside the bound
 *   - monotonic expansion (once active, never retracts)
 */

import {
  ToolsetSelector,
  REQUEST_TOOLS_NAME,
  BUGFIX_BASE,
  READONLY_BASE,
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

function makeTools(names: string[]): OpenAI.ChatCompletionTool[] {
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: `tool ${name}`, parameters: { type: 'object' as const, properties: {} } },
  }))
}

const ALL_TOOLS = makeTools(ALL_NAMES)

describe('ToolsetSelector (profile-bound)', () => {
  describe('bugfix_local (default)', () => {
    it('starts with the BUGFIX_BASE toolset (~6 tools), not all 36', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const { tools, activeCount, totalCount, allActive } = selector.selectForTurn(ALL_TOOLS, 'fix a typo')
      const toolNames = tools.map((t) => t.function.name)
      for (const base of BUGFIX_BASE) {
        expect(toolNames).toContain(base)
      }
      expect(activeCount).toBe(BUGFIX_BASE.length)
      expect(totalCount).toBe(ALL_NAMES.length)
      expect(allActive).toBe(false)
      // request_tools meta-tool is injected (not all allowed tools active).
      expect(toolNames).toContain(REQUEST_TOOLS_NAME)
    })

    it('does NOT activate EDIT_FILE or WRITE_FILE by default (must be requested)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const { tools } = selector.selectForTurn(ALL_TOOLS, 'fix a typo')
      const toolNames = tools.map((t) => t.function.name)
      expect(toolNames).not.toContain(EDIT_FILE)
      expect(toolNames).not.toContain(WRITE_FILE)
    })

    it('does NOT expand to provision/shell/destructive from user text', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      selector.selectForTurn(ALL_TOOLS, 'deploy auth create file git commit')
      // These groups are outside bugfix_local's allowed set.
      expect(selector.isActive(PROVISION_DEPLOY)).toBe(false)
      expect(selector.isActive(START_DEV_SERVER)).toBe(false)
      expect(selector.isActive(WRITE_FILE)).toBe(false)
      expect(selector.isActive(CREATE_FILE)).toBe(false)
    })

    it('activates EDIT_FILE via request_tools (inside the allowed bound)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const result = selector.requestTools([EDIT_FILE])
      expect(result.added).toEqual([EDIT_FILE])
      expect(result.denied).toEqual([])
      expect(selector.isActive(EDIT_FILE)).toBe(true)
    })

    it('DENIES edit_file via request_tools when readOnly is active', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local', true)
      const result = selector.requestTools([EDIT_FILE])
      expect(result.added).toEqual([])
      expect(result.denied).toEqual([EDIT_FILE])
      expect(selector.getExpandedNames()).not.toContain(EDIT_FILE)
      expect(selector.getDeniedNames()).toContain(EDIT_FILE)
      expect(selector.isActive(EDIT_FILE)).toBe(false)
      expect(selector.selectForTurn(ALL_TOOLS).tools.map((t) => t.function.name)).not.toContain(EDIT_FILE)
    })

    it('DENIES destructive create/write via request_tools (outside bound)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const result = selector.requestTools([WRITE_FILE, CREATE_FILE, DELETE_FILE])
      expect(result.added).toEqual([])
      expect(result.denied).toEqual(expect.arrayContaining([WRITE_FILE, CREATE_FILE, DELETE_FILE]))
      expect(selector.isActive(WRITE_FILE)).toBe(false)
      // Denied names are tracked for the usage log.
      expect(selector.getDeniedNames()).toEqual(expect.arrayContaining([WRITE_FILE, CREATE_FILE, DELETE_FILE]))
    })

    it('reports expanded + denied names for the usage log', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      selector.requestTools([EDIT_FILE, WRITE_FILE])
      expect(selector.getExpandedNames()).toEqual([EDIT_FILE])
      expect(selector.getDeniedNames()).toEqual([WRITE_FILE])
    })

    it('activates model-planned groups without reading user text', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local', false, ['FILE_OPS'])
      selector.selectForTurn(ALL_TOOLS)
      expect(selector.isActive(LIST_DIRECTORY)).toBe(true)
      expect(selector.isActive(READ_SKILL)).toBe(true)
      expect(selector.isActive(WRITE_FILE)).toBe(false)
    })
  })

  describe('analysis_readonly (hard read-only)', () => {
    it('starts with the READONLY_BASE set (no execute_command, no edit_file)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'analysis_readonly', true)
      const { tools, activeCount } = selector.selectForTurn(ALL_TOOLS, 'check the dialogs')
      const toolNames = tools.map((t) => t.function.name)
      for (const base of READONLY_BASE) {
        expect(toolNames).toContain(base)
      }
      expect(activeCount).toBe(READONLY_BASE.length)
      // No destructive or execute tools.
      expect(toolNames).not.toContain(EDIT_FILE)
      expect(toolNames).not.toContain(WRITE_FILE)
      expect(toolNames).not.toContain(EXECUTE_COMMAND)
    })

    it('DENIES edit_file even when the model requests it via request_tools', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'analysis_readonly', true)
      const result = selector.requestTools([EDIT_FILE, EXECUTE_COMMAND])
      expect(result.added).toEqual([])
      expect(result.denied).toEqual(expect.arrayContaining([EDIT_FILE, EXECUTE_COMMAND]))
      expect(selector.isActive(EDIT_FILE)).toBe(false)
    })

    it('is allActive within its read-only ceiling (no request_tools injected)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'analysis_readonly', true)
      const { tools, allActive } = selector.selectForTurn(ALL_TOOLS, 'verify the config')
      // allActive is measured against the ALLOWED ceiling, not all 36.
      expect(allActive).toBe(true)
      expect(tools.map((t) => t.function.name)).not.toContain(REQUEST_TOOLS_NAME)
    })
  })

  describe('deploy_publish', () => {
    it('starts with PROVISION + SHELL for deploy_publish profile', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'deploy_publish')
      selector.selectForTurn(ALL_TOOLS)
      expect(selector.isActive(PROVISION_DEPLOY)).toBe(true)
      expect(selector.isActive(START_DEV_SERVER)).toBe(true)
    })

    it('with readOnly=true, strips ALL mutating tools (destructive + provision + shell)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'deploy_publish', true)
      selector.selectForTurn(ALL_TOOLS, 'deploy without editing files')
      // readOnly removes destructive file tools…
      expect(selector.isActive(EDIT_FILE)).toBe(false)
      expect(selector.isActive(WRITE_FILE)).toBe(false)
      // …AND provision (creates cloud resources)…
      expect(selector.isActive(PROVISION_DEPLOY)).toBe(false)
      expect(selector.isActive(PROVISION_AUTH)).toBe(false)
      // …AND shell/dev-server/background (can mutate via commands).
      expect(selector.isActive(START_DEV_SERVER)).toBe(false)
      expect(selector.isActive(AGENT_SHELL_START)).toBe(false)
      expect(selector.isActive(EXECUTE_COMMAND_BACKGROUND)).toBe(false)
      // execute_command (synchronous) is NOT blocked — useful for read-only
      // inspection like `git log` / `ls`.
      expect(selector.isActive(EXECUTE_COMMAND)).toBe(true)
      // And can't be requested back.
      const result = selector.requestTools([EDIT_FILE, PROVISION_DEPLOY])
      expect(result.denied).toEqual(expect.arrayContaining([EDIT_FILE, PROVISION_DEPLOY]))
    })
  })

  describe('monotonic + meta-tool', () => {
    it('expands monotonically — once active, a tool never leaves', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'deploy_publish')
      selector.selectForTurn(ALL_TOOLS)
      expect(selector.isActive(PROVISION_DEPLOY)).toBe(true)
      selector.selectForTurn(ALL_TOOLS, 'now fix a typo')
      expect(selector.isActive(PROVISION_DEPLOY)).toBe(true)
    })

    it('omits request_tools meta-tool when all ALLOWED tools are active', () => {
      // bugfix_local allowed = BUGFIX_BASE + edit/update/list/read_skill.
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      selector.requestTools([EDIT_FILE, UPDATE_TASKS, LIST_DIRECTORY, READ_SKILL])
      const { tools, allActive } = selector.selectForTurn(ALL_TOOLS, 'do something')
      expect(allActive).toBe(true)
      expect(tools.map((t) => t.function.name)).not.toContain(REQUEST_TOOLS_NAME)
    })

    it('expandForToolName() respects the bound (false for denied tools)', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      expect(selector.expandForToolName(EDIT_FILE)).toBe(true)
      expect(selector.expandForToolName(WRITE_FILE)).toBe(false)
      expect(selector.expandForToolName('nonexistent')).toBe(false)
    })

    it('only activates tools that exist in the registry', () => {
      const selector = new ToolsetSelector([...BUGFIX_BASE], 'bugfix_local')
      selector.selectForTurn(ALL_TOOLS, 'create a new file')
      // WRITE_FILE is outside both the registry and the bound.
      expect(selector.isActive(WRITE_FILE)).toBe(false)
    })
  })

  describe('profile/readOnly accessors', () => {
    it('exposes the profile and readOnly flag for the usage log', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'analysis_readonly', true)
      expect(selector.getProfile()).toBe('analysis_readonly')
      expect(selector.isReadOnly()).toBe(true)
    })
  })
})
