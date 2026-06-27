/**
 * Dynamic toolset selection — sends only the tools the current task needs
 * instead of all 36 definitions on every request.
 *
 * WHY THIS EXISTS
 * ─────────────
 * Every turn of the agent loop re-sends the full tool catalog as JSON schemas.
 * 36 tools × ~300 tokens each ≈ 10K+ tokens of tool-definitions overhead on
 * EVERY request — even a one-line bugfix that only needs read_file + edit_file.
 * That's ~10K tokens billed as input on every turn, inflating cost and context
 * pressure for no value.
 *
 * HOW IT WORKS
 * ────────────
 * The selector starts with a CORE toolset (search, read, edit, execute,
 * ask_user_question, update_tasks) and expands monotonically — once a tool
 * is activated it stays active for the rest of the run (never retracted, so
 * the tool-schema prefix stabilises and Anthropic prompt-caching can reuse it).
 *
 * Expansion triggers (any match keeps the group active for the session):
 *   1. Keyword in the user's message ("deploy", "auth", "git", "memory" …)
 *      → activates the matching group immediately.
 *   2. The agent calls the `request_tools` meta-tool explicitly → activates
 *      the named tools for the next turn.
 *   3. The toolExecutor receives a call for a tool that exists in the registry
 *      but isn't active → activates it (defensive: covers model hallucination
 *      of a tool name it read about in the system prompt).
 *
 * The `request_tools` meta-tool is injected into every active set (until ALL
 * tools are active) so the model can ask for capabilities it doesn't have.
 */

import type OpenAI from 'openai'
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
} from './toolNames'

// ── Tool groups ──────────────────────────────────────────────────────────

/** The minimal toolset for a localized code task. Always active. */
export const CORE_TOOLS = [
  SEARCH_FILES, READ_FILE, READ_LARGE_RESULT, EDIT_FILE,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS,
] as const

/** File operations beyond edit_file (create, delete, rename, list, glob, skills). */
export const FILE_OPS_TOOLS = [
  WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  LIST_DIRECTORY, GLOB, READ_SKILL,
] as const

/** Shell / dev-server / background-command tools. */
export const SHELL_TOOLS = [
  EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER, READ_DEV_SERVER_LOGS,
] as const

/** Web research tools. */
export const WEB_TOOLS = [WEB_FETCH] as const

/** Sub-agent delegation tools. */
export const SUBAGENT_TOOLS = [DELEGATE, COLLECT_RESULTS] as const

/** Persistent memory tools. */
export const MEMORY_TOOLS = [SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY] as const

/** Platform provisioning tools (auth, database, files, deploy, credentials). */
export const PROVISION_TOOLS = [
  PROVISION_AUTH, PROVISION_DATABASE, PROVISION_FILES, PROVISION_DEPLOY,
  REQUEST_CREDENTIALS,
] as const

type GroupName = 'FILE_OPS' | 'SHELL' | 'WEB' | 'SUBAGENT' | 'MEMORY' | 'PROVISION'

const GROUP_TOOLS: Record<GroupName, readonly string[]> = {
  FILE_OPS: FILE_OPS_TOOLS,
  SHELL: SHELL_TOOLS,
  WEB: WEB_TOOLS,
  SUBAGENT: SUBAGENT_TOOLS,
  MEMORY: MEMORY_TOOLS,
  PROVISION: PROVISION_TOOLS,
}

// ── Expansion triggers (keyword → groups) ────────────────────────────────

interface ExpansionTrigger {
  /** Case-insensitive regex tested against the user's message text. */
  pattern: RegExp
  groups: GroupName[]
}

const EXPANSION_TRIGGERS: ExpansionTrigger[] = [
  { pattern: /deploy|publish|release|ship\b/i, groups: ['PROVISION', 'SHELL'] },
  { pattern: /browser|preview|screenshot|webview|canvas/i, groups: ['SHELL'] },
  { pattern: /\bgit\b|commit|branch|push|merge|rebase|stash/i, groups: ['SHELL'] },
  { pattern: /\bimage\b|screenshot|html2canvas/i, groups: ['SHELL'] },
  { pattern: /web_fetch|fetch.*url|research.*web|docs.*online|look.*up/i, groups: ['WEB', 'SUBAGENT'] },
  { pattern: /memory|remember|forget\b/i, groups: ['MEMORY'] },
  { pattern: /auth|login|sign.?up|sign.?in|firebase/i, groups: ['PROVISION'] },
  { pattern: /database|sql|sqlite|turso|libsql|schema\b/i, groups: ['PROVISION'] },
  { pattern: /sub.?agent|delegate|verify.*agent|research.*agent/i, groups: ['SUBAGENT'] },
  { pattern: /skill|read_skill/i, groups: ['FILE_OPS'] },
  { pattern: /create.*file|new.*file|write.*file/i, groups: ['FILE_OPS'] },
  { pattern: /delete|remove.*file|rm\b/i, groups: ['FILE_OPS'] },
  { pattern: /rename|move.*file|mv\b/i, groups: ['FILE_OPS'] },
  { pattern: /background.*command|long.?running/i, groups: ['SHELL'] },
  { pattern: /dev.*server|watch|hot.?reload|vite|wrangler/i, groups: ['SHELL'] },
  { pattern: /credential|api.?key|secret|\.env\b/i, groups: ['PROVISION'] },
]

// ── Meta-tool: request_tools ─────────────────────────────────────────────

export const REQUEST_TOOLS_NAME = 'request_tools'

/**
 * The `request_tools` meta-tool definition. Injected into the active set so
 * the model can ask for capabilities that aren't currently available. The
 * agentService bridge intercepts calls to this name and forwards them to the
 * selector — the toolExecutor never sees it.
 */
export function requestToolsDefinition(allInactiveNames: string[]): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: REQUEST_TOOLS_NAME,
      description:
        'Request additional tools that are NOT in the current active toolset. ' +
        'Use this when you need a capability that is not currently available ' +
        '(e.g. write_file, create_file, delegate, save_memory, provision_*). ' +
        'The requested tools will be available on the NEXT turn. ' +
        'Call this ONCE with all the tools you need — do not call it repeatedly ' +
        'for individual tools. After calling this, finish your current turn; ' +
        'the tools will be active when you resume.',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tool names to activate. Tools currently NOT active: ' +
              (allInactiveNames.length > 0
                ? allInactiveNames.join(', ')
                : '(all tools are already active)'),
          },
        },
        required: ['tools'],
      },
    },
  }
}

// ── Selector ─────────────────────────────────────────────────────────────

export interface ToolsetSelection {
  /** The filtered tool definitions to send in the request. */
  tools: OpenAI.ChatCompletionTool[]
  /** Number of tools in the active set (excluding request_tools). */
  activeCount: number
  /** Total tools available (excluding request_tools). */
  totalCount: number
  /** True when all available tools are active (request_tools is then omitted). */
  allActive: boolean
}

export interface RequestToolsResult {
  /** Tool names that were newly activated. */
  added: string[]
  /** Tool names that were already active. */
  alreadyActive: string[]
  /** Tool names that don't exist in the available set. */
  unknown: string[]
}

/**
 * Stateful toolset selector. One per agent run. Expands monotonically —
 * once a tool is activated it never leaves the active set, so the tool-schema
 * prefix stabilises and prompt-caching can reuse it.
 */
export class ToolsetSelector {
  /** Names of tools that are currently active (starts with CORE). */
  private activeToolNames: Set<string>
  /** All available tool names (from the toolExecutor registry). */
  private allToolNames: Set<string>

  constructor(allToolNames: string[]) {
    this.allToolNames = new Set(allToolNames)
    // Start with CORE — only keep names that actually exist in the registry.
    this.activeToolNames = new Set(
      CORE_TOOLS.filter((n) => this.allToolNames.has(n)),
    )
  }

  /**
   * Select the active tools for this turn, expanding based on keywords in the
   * user's message text. Returns the filtered definitions + the request_tools
   * meta-tool (when not all tools are active).
   *
   * @param allTools  All tool definitions from the toolExecutor.
   * @param userText  Concatenated user-message text for keyword detection.
   */
  selectForTurn(
    allTools: OpenAI.ChatCompletionTool[],
    userText: string,
  ): ToolsetSelection {
    // 1. Expand based on keywords in the user message.
    if (userText) {
      for (const trigger of EXPANSION_TRIGGERS) {
        if (trigger.pattern.test(userText)) {
          for (const group of trigger.groups) {
            for (const name of GROUP_TOOLS[group]) {
              if (this.allToolNames.has(name)) {
                this.activeToolNames.add(name)
              }
            }
          }
        }
      }
    }

    // 2. Build the filtered list, preserving the original order.
    const activeTools = allTools.filter((t) =>
      this.activeToolNames.has(t.function.name),
    )

    const allActive = this.activeToolNames.size >= this.allToolNames.size
    const tools = allActive
      ? activeTools
      : [...activeTools, this.buildRequestToolsMetaTool()]

    return {
      tools,
      activeCount: this.activeToolNames.size,
      totalCount: this.allToolNames.size,
      allActive,
    }
  }

  /**
   * Activate specific tool names (called by the request_tools meta-tool bridge).
   * Returns which were newly added, already active, or unknown.
   */
  requestTools(toolNames: string[]): RequestToolsResult {
    const added: string[] = []
    const alreadyActive: string[] = []
    const unknown: string[] = []
    for (const name of toolNames) {
      if (!this.allToolNames.has(name)) {
        unknown.push(name)
      } else if (this.activeToolNames.has(name)) {
        alreadyActive.push(name)
      } else {
        this.activeToolNames.add(name)
        added.push(name)
      }
    }
    return { added, alreadyActive, unknown }
  }

  /**
   * Activate a single tool by name (defensive: called when the executor
   * receives a call for a tool that exists but isn't active). No-op if the
   * tool doesn't exist or is already active.
   */
  expandForToolName(toolName: string): boolean {
    if (this.allToolNames.has(toolName) && !this.activeToolNames.has(toolName)) {
      this.activeToolNames.add(toolName)
      return true
    }
    return false
  }

  /** Whether a tool name is currently in the active set. */
  isActive(toolName: string): boolean {
    return this.activeToolNames.has(toolName)
  }

  /** Build the request_tools meta-tool with the current inactive names listed. */
  private buildRequestToolsMetaTool(): OpenAI.ChatCompletionTool {
    const inactive = Array.from(this.allToolNames).filter(
      (n) => !this.activeToolNames.has(n),
    )
    return requestToolsDefinition(inactive)
  }
}
