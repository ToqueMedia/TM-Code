/**
 * Tool name constants — single source of truth.
 *
 * The system prompt (chat + cmd-mode), the /plan architect prompt, and the
 * mechanical access controls (planMode allowlist, env-file gate) all
 * reference tools by name. Hardcoding literals across ~70 sites means a
 * rename in toolExecutor silently desyncs the prompt: the model is told
 * to use a tool that no longer exists, and the desync is invisible until a
 * developer notices the agent calling a phantom name.
 *
 * Centralising the names here makes a rename one-line: change the literal
 * once, and every prompt + every allowlist update simultaneously. Mirrors
 * the `BASH_TOOL_NAME`, `FILE_READ_TOOL_NAME` pattern used in claude-vaz.
 *
 * Add a new tool: add the export here AND register the same string in
 * `toolExecutor.registerTools` via `this.tools.set(<NAME>, ...)`.
 */

// Read tools — concurrency-safe, allowed in /plan architect mode
export const READ_FILE = 'read_file'
export const LIST_DIRECTORY = 'list_directory'
export const SEARCH_FILES = 'search_files'
export const GLOB = 'glob'
export const GET_DIAGNOSTICS = 'get_diagnostics'
export const READ_SKILL = 'read_skill'
export const READ_LARGE_RESULT = 'read_large_result'
export const READ_DEV_SERVER_LOGS = 'read_dev_server_logs'

// Write tools — produce diffs, require approval
export const WRITE_FILE = 'write_file'
export const CREATE_FILE = 'create_file'
export const EDIT_FILE = 'edit_file'
export const CREATE_DIRECTORY = 'create_directory'
export const DELETE_FILE = 'delete_file'
export const RENAME_FILE = 'rename_file'

// Execution / dev server
export const EXECUTE_COMMAND = 'execute_command'
export const START_DEV_SERVER = 'start_dev_server'

// Web / research
export const WEB_SEARCH = 'web_search'
export const WEB_FETCH = 'web_fetch'
export const RESEARCH = 'research'

// Internal task tracking
export const UPDATE_TASKS = 'update_tasks'
export const CHECK_BACKGROUND_AGENTS = 'check_background_agents'
export const SPAWN_BACKGROUND_AGENT = 'spawn_background_agent'

// Platform integrations
export const PROVISION_AUTH = 'provision_auth'
export const PROVISION_DEPLOY = 'provision_deploy'
export const REQUEST_CREDENTIALS = 'request_credentials'

// Verification sub-agent
export const VERIFY = 'verify'

/**
 * Every tool name registered by ToolExecutor. Walked by
 * `scripts/verify-skills.ts` to assert that every `provision_auth`-style
 * reference inside a SKILL.md still points at a real tool — a removed
 * or renamed tool that's still mentioned in markdown becomes a CI
 * failure rather than a silent prompt regression.
 *
 * Keep in sync with `ToolExecutor.tools.set(...)` registrations: the
 * verifier walks both surfaces and reports drift in either direction.
 */
export const TOOL_NAMES = [
  READ_FILE, LIST_DIRECTORY, SEARCH_FILES, GLOB, GET_DIAGNOSTICS,
  READ_SKILL, READ_LARGE_RESULT, READ_DEV_SERVER_LOGS,
  WRITE_FILE, CREATE_FILE, EDIT_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  EXECUTE_COMMAND, START_DEV_SERVER,
  WEB_SEARCH, WEB_FETCH, RESEARCH,
  UPDATE_TASKS, CHECK_BACKGROUND_AGENTS, SPAWN_BACKGROUND_AGENT,
  PROVISION_AUTH, PROVISION_DEPLOY, REQUEST_CREDENTIALS,
  VERIFY,
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

const TOOL_NAMES_SET: ReadonlySet<string> = new Set(TOOL_NAMES)

/** True iff `name` is a registered tool. Used by the SKILL verifier
 *  (`scripts/verify-skills.ts`) to detect stale tool-name references. */
export function isKnownToolName(name: string): name is ToolName {
  return TOOL_NAMES_SET.has(name)
}
