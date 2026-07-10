/**
 * Tool name constants — single source of truth.
 *
 * The system prompts, the /plan architect prompt, and the
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
export const READ_AROUND = 'read_around'
export const LIST_DIRECTORY = 'list_directory'
export const SEARCH_FILES = 'search_files'
export const GLOB = 'glob'
export const READ_SKILL = 'read_skill'
export const READ_LARGE_RESULT = 'read_large_result'
export const READ_DEV_SERVER_LOGS = 'read_dev_server_logs'
/** Code intelligence (Monaco TS worker): definitions/references/hover/symbols/diagnostics. */
export const LSP = 'lsp'

// Claude-like read aliases — exposed to the model, mapped internally to the
// TM Code tools above. Keep internal names stable for history/telemetry.
export const READ_ALIAS = 'Read'
export const GREP_ALIAS = 'Grep'
export const GLOB_ALIAS = 'Glob'
export const LS_ALIAS = 'LS'

// Write tools — produce diffs, require approval
export const WRITE_FILE = 'write_file'
export const CREATE_FILE = 'create_file'
export const EDIT_FILE = 'edit_file'
export const CREATE_DIRECTORY = 'create_directory'
export const DELETE_FILE = 'delete_file'
export const RENAME_FILE = 'rename_file'

// Execution / dev server
export const EXECUTE_COMMAND = 'execute_command'
export const EXECUTE_COMMAND_BACKGROUND = 'execute_command_background'
export const CHECK_BACKGROUND_COMMANDS = 'check_background_commands'
export const AGENT_SHELL_START = 'agent_shell_start'
export const AGENT_SHELL_WRITE = 'agent_shell_write'
export const AGENT_SHELL_READ = 'agent_shell_read'
export const AGENT_SHELL_STOP = 'agent_shell_stop'
export const START_DEV_SERVER = 'start_dev_server'
export const STOP_DEV_SERVER = 'stop_dev_server'

// Web / research
export const WEB_SEARCH = 'web_search'
export const WEB_FETCH = 'web_fetch'

// Sub-agent delegation (v0.7.0 — replaces research, verify, spawn_background_agent)
export const DELEGATE = 'delegate'
export const COLLECT_RESULTS = 'collect_results'

// Internal task tracking
export const UPDATE_TASKS = 'update_tasks'

// User interaction
// (provision_auth/database/files/deploy were removed in the dev-only-IDE
// pivot, 2026-07 — the managed layer lives in TM Code Web.)
export const REQUEST_CREDENTIALS = 'request_credentials'
export const ASK_USER_QUESTION = 'ask_user_question'

// Verify sub-agent — removed in v0.7.0, replaced by task(subagent_type='Verify')

// Persistent memory (memdir) — see services/agent/memdir.ts
export const SAVE_MEMORY = 'save_memory'
export const FORGET_MEMORY = 'forget_memory'
export const READ_MEMORY = 'read_memory'
export const DISTILL_MEMORY = 'distill_memory'
export const UPDATE_SESSION_MEMORY = 'update_session_memory'
export const READ_SESSION_MEMORY = 'read_session_memory'

/**
 * Every tool name registered by ToolExecutor. Walked by
 * `scripts/verify-skills.ts` to assert that every tool-name reference
 * inside a SKILL.md still points at a real tool — a removed or renamed
 * tool that's still mentioned in markdown becomes a CI failure rather
 * than a silent prompt regression.
 *
 * Keep in sync with `ToolExecutor.tools.set(...)` registrations: the
 * verifier walks both surfaces and reports drift in either direction.
 */
export const TOOL_NAMES = [
  READ_FILE, READ_AROUND, LIST_DIRECTORY, SEARCH_FILES, GLOB,
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
  READ_SKILL, READ_LARGE_RESULT, READ_DEV_SERVER_LOGS, LSP,
  WRITE_FILE, CREATE_FILE, EDIT_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  EXECUTE_COMMAND, EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER,
  WEB_SEARCH, WEB_FETCH,
  DELEGATE, COLLECT_RESULTS,
  UPDATE_TASKS,
  REQUEST_CREDENTIALS, ASK_USER_QUESTION,
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY, UPDATE_SESSION_MEMORY, READ_SESSION_MEMORY,
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

const TOOL_NAMES_SET: ReadonlySet<string> = new Set(TOOL_NAMES)

/** True iff `name` is a registered tool. Used by the SKILL verifier
 *  (`scripts/verify-skills.ts`) to detect stale tool-name references. */
export function isKnownToolName(name: string): name is ToolName {
  return TOOL_NAMES_SET.has(name)
}

export function canonicalToolName(name: string): string {
  switch (name) {
    case READ_ALIAS: return READ_FILE
    case GREP_ALIAS: return SEARCH_FILES
    case GLOB_ALIAS: return GLOB
    case LS_ALIAS: return LIST_DIRECTORY
    default: return name
  }
}

export function normalizeToolInputForCanonical(
  requestedToolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (requestedToolName) {
    case READ_ALIAS:
      return {
        ...input,
        file_path: input.file_path ?? input.path,
      }
    case GREP_ALIAS: {
      const glob = input.glob
      const includePatterns = Array.isArray(input.includePatterns)
        ? input.includePatterns
        : typeof glob === 'string' && glob.trim()
          ? [glob]
          : undefined
      return {
        ...input,
        query: input.query ?? input.pattern,
        directory: input.directory ?? input.path ?? '.',
        ...(includePatterns ? { includePatterns } : {}),
        // Paridade com o Grep do Claude Code: o pattern é SEMPRE regex
        // (ripgrep). Com o default antigo (literal), `a|b` procurava a
        // string com os pipes e devolvia um "No matches found" FALSO — o
        // modelo (treinado no Claude Code) usa alternação sem hesitar e
        // era enganado em silêncio. useRegex explícito continua a mandar.
        useRegex: input.useRegex ?? true,
      }
    }
    case GLOB_ALIAS:
      return {
        ...input,
        directory: input.directory ?? input.path,
      }
    case LS_ALIAS:
      return {
        ...input,
        file_path: input.file_path ?? input.path ?? input.directory ?? '.',
      }
    default:
      return input
  }
}
