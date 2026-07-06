/**
 * Tests for the dynamic toolset selector.
 *
 * Profiles choose the starter toolset only. request_tools can activate any
 * registered tool on demand unless a hard explicit read-only/no-edit policy
 * blocks it. On-demand activations are transient: offered for one model step,
 * then removed unless requested again.
 */

import {
  ToolsetSelector,
  REQUEST_TOOLS_NAME,
  BUGFIX_BASE,
  READONLY_BASE,
} from '../toolsetSelector'
import {
  SEARCH_FILES, READ_FILE, READ_AROUND, READ_LARGE_RESULT, EDIT_FILE,
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
  WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  LIST_DIRECTORY, GLOB, READ_SKILL,
  EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER, READ_DEV_SERVER_LOGS,
  WEB_FETCH,
  DELEGATE, COLLECT_RESULTS,
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY,
  UPDATE_SESSION_MEMORY, READ_SESSION_MEMORY,
  PROVISION_AUTH, PROVISION_DATABASE, PROVISION_FILES, PROVISION_DEPLOY,
  REQUEST_CREDENTIALS,
} from '../toolNames'
import type OpenAI from 'openai'

const ALL_NAMES = [
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
  SEARCH_FILES, READ_FILE, READ_AROUND, READ_LARGE_RESULT, EDIT_FILE,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
  WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  LIST_DIRECTORY, GLOB, READ_SKILL,
  EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER, READ_DEV_SERVER_LOGS,
  WEB_FETCH,
  DELEGATE, COLLECT_RESULTS,
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY,
  UPDATE_SESSION_MEMORY, READ_SESSION_MEMORY,
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

function toolNamesFor(selector: ToolsetSelector): string[] {
  return selector.selectForTurn(ALL_TOOLS).tools.map((t) => t.function.name)
}

describe('ToolsetSelector (on-demand)', () => {
  describe('starter profiles', () => {
    it('project_bootstrap starts focused but can request more tools', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'project_bootstrap')
      const firstTurn = selector.selectForTurn(ALL_TOOLS)
      const names = firstTurn.tools.map((t) => t.function.name)

      expect(names).toEqual(expect.arrayContaining([
        LS_ALIAS,
        GLOB_ALIAS,
        GREP_ALIAS,
        READ_ALIAS,
        LIST_DIRECTORY,
        GLOB,
        SEARCH_FILES,
        READ_FILE,
        READ_AROUND,
        WRITE_FILE,
        CREATE_FILE,
        ASK_USER_QUESTION,
      ]))
      expect(names).not.toContain(EXECUTE_COMMAND)
      expect(names).not.toContain(EDIT_FILE)
      expect(firstTurn.allActive).toBe(false)
      expect(names).toContain(REQUEST_TOOLS_NAME)

      const result = selector.requestTools([EXECUTE_COMMAND, EDIT_FILE, START_DEV_SERVER])
      expect(result.added).toEqual([EXECUTE_COMMAND, EDIT_FILE, START_DEV_SERVER])
      expect(result.denied).toEqual([])
      expect(selector.isActive(EXECUTE_COMMAND)).toBe(true)
    })

    it('can switch to the original task profile after bootstrap completes', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'project_bootstrap')
      selector.requestTools([START_DEV_SERVER])
      selector.switchProfile('bugfix_local', false)

      expect(selector.getProfile()).toBe('bugfix_local')
      expect(selector.isActive(EXECUTE_COMMAND)).toBe(true)
      expect(selector.isActive(WRITE_FILE)).toBe(false)
      expect(selector.isActive(START_DEV_SERVER)).toBe(false)
    })

    it('bugfix_local starts with BUGFIX_BASE and request_tools', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const { tools, activeCount, totalCount, allActive } = selector.selectForTurn(ALL_TOOLS)
      const names = tools.map((t) => t.function.name)

      for (const base of BUGFIX_BASE) {
        expect(names).toContain(base)
      }
      expect(activeCount).toBe(BUGFIX_BASE.length)
      expect(totalCount).toBe(ALL_NAMES.length)
      expect(allActive).toBe(false)
      expect(names).toContain(REQUEST_TOOLS_NAME)
      expect(names).not.toContain(EDIT_FILE)
      expect(names).not.toContain(WRITE_FILE)
    })

    it('model-planned groups preload tools without limiting later requests', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local', false, ['FILE_OPS'])

      expect(selector.isActive(LIST_DIRECTORY)).toBe(true)
      expect(selector.isActive(READ_SKILL)).toBe(true)
      expect(selector.isActive(WRITE_FILE)).toBe(true)

      const result = selector.requestTools([PROVISION_DEPLOY])
      expect(result.added).toEqual([PROVISION_DEPLOY])
      expect(result.denied).toEqual([])
    })
  })

  describe('request_tools', () => {
    it('activates any registered inactive tool on demand', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const result = selector.requestTools([EDIT_FILE, WRITE_FILE, CREATE_FILE, DELETE_FILE, PROVISION_DEPLOY])

      expect(result.added).toEqual([EDIT_FILE, WRITE_FILE, CREATE_FILE, DELETE_FILE, PROVISION_DEPLOY])
      expect(result.denied).toEqual([])
      expect(result.unknown).toEqual([])
      expect(selector.isActive(WRITE_FILE)).toBe(true)
      expect(selector.getExpandedNames()).toEqual(expect.arrayContaining([
        EDIT_FILE,
        WRITE_FILE,
        CREATE_FILE,
        DELETE_FILE,
        PROVISION_DEPLOY,
      ]))
    })

    it('reports already active and unknown names without denying registered tools', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      const result = selector.requestTools([READ_FILE, 'not_a_tool', SAVE_MEMORY])

      expect(result.added).toEqual([SAVE_MEMORY])
      expect(result.alreadyActive).toEqual([READ_FILE])
      expect(result.unknown).toEqual(['not_a_tool'])
      expect(result.denied).toEqual([])
    })

    it('drops requested tools after they have been offered once', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      selector.requestTools([WRITE_FILE])

      expect(toolNamesFor(selector)).toContain(WRITE_FILE)
      expect(selector.isActive(WRITE_FILE)).toBe(true)

      expect(toolNamesFor(selector)).not.toContain(WRITE_FILE)
      expect(selector.isActive(WRITE_FILE)).toBe(false)
      expect(selector.getExpandedNames()).toContain(WRITE_FILE)
    })

    it('omits request_tools only when every requestable tool is active for this model step', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')
      selector.requestTools(ALL_NAMES.filter((name) => !BUGFIX_BASE.includes(name as (typeof BUGFIX_BASE)[number])))

      const first = selector.selectForTurn(ALL_TOOLS)
      expect(first.allActive).toBe(true)
      expect(first.tools.map((t) => t.function.name)).not.toContain(REQUEST_TOOLS_NAME)

      const second = selector.selectForTurn(ALL_TOOLS)
      expect(second.allActive).toBe(false)
      expect(second.tools.map((t) => t.function.name)).toContain(REQUEST_TOOLS_NAME)
    })
  })

  describe('read-only hint vs enforcement', () => {
    it('analysis_readonly is a starter set and can expand when not hard-enforced', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'analysis_readonly', true, [], false)
      const names = toolNamesFor(selector)

      for (const base of READONLY_BASE) {
        expect(names).toContain(base)
      }
      expect(names).not.toContain(EDIT_FILE)
      expect(selector.isReadOnly()).toBe(false)
      expect(selector.getReadOnlyHint()).toBe(true)

      const result = selector.requestTools([EDIT_FILE, EXECUTE_COMMAND, PROVISION_DEPLOY])
      expect(result.added).toEqual([EDIT_FILE, EXECUTE_COMMAND, PROVISION_DEPLOY])
      expect(result.denied).toEqual([])
    })

    it('hard explicit read-only denies mutating/provision/shell tools only', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'analysis_readonly', true)
      const result = selector.requestTools([EDIT_FILE, PROVISION_DEPLOY, START_DEV_SERVER, EXECUTE_COMMAND])

      expect(result.added).toEqual([EXECUTE_COMMAND])
      expect(result.denied).toEqual(expect.arrayContaining([EDIT_FILE, PROVISION_DEPLOY, START_DEV_SERVER]))
      expect(selector.isActive(EDIT_FILE)).toBe(false)
      expect(selector.isActive(EXECUTE_COMMAND)).toBe(true)
      expect(selector.getDeniedNames()).toEqual(expect.arrayContaining([EDIT_FILE, PROVISION_DEPLOY, START_DEV_SERVER]))
    })

    it('deploy_publish with hard read-only strips blocked starter tools', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'deploy_publish', true)

      expect(selector.isActive(EDIT_FILE)).toBe(false)
      expect(selector.isActive(WRITE_FILE)).toBe(false)
      expect(selector.isActive(PROVISION_DEPLOY)).toBe(false)
      expect(selector.isActive(PROVISION_AUTH)).toBe(false)
      expect(selector.isActive(START_DEV_SERVER)).toBe(false)
      expect(selector.isActive(AGENT_SHELL_START)).toBe(false)
      expect(selector.isActive(EXECUTE_COMMAND_BACKGROUND)).toBe(false)
      expect(selector.isActive(EXECUTE_COMMAND)).toBe(true)
    })
  })

  describe('defensive expansion', () => {
    it('activates registered direct tool calls on demand', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local')

      expect(selector.expandForToolName(WRITE_FILE)).toBe(true)
      expect(selector.isActive(WRITE_FILE)).toBe(true)
      expect(selector.getExpandedNames()).toContain(WRITE_FILE)
      expect(selector.expandForToolName('nonexistent')).toBe(false)
    })

    it('respects hard explicit read-only for direct tool calls', () => {
      const selector = new ToolsetSelector(ALL_NAMES, 'bugfix_local', true)

      expect(selector.expandForToolName(EDIT_FILE)).toBe(false)
      selector.noteDeniedToolName(EDIT_FILE)
      expect(selector.getDeniedNames()).toContain(EDIT_FILE)
      expect(selector.expandForToolName(EXECUTE_COMMAND)).toBe(false)
    })

    it('only activates tools that exist in the registry', () => {
      const selector = new ToolsetSelector([...BUGFIX_BASE], 'bugfix_local')
      const result = selector.requestTools([WRITE_FILE])

      expect(result.unknown).toEqual([WRITE_FILE])
      expect(selector.isActive(WRITE_FILE)).toBe(false)
    })
  })
})
