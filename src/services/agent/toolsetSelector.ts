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
 * The selector starts with the model-selected profile base and optional
 * model-planned tool groups. It expands monotonically — once a tool is
 * activated it stays active for the rest of the run (never retracted, so the
 * tool-schema prefix stabilises and Anthropic prompt-caching can reuse it).
 *
 * Expansion sources:
 *   1. Context/tool plan from the utility model activates groups up front.
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
import type { PromptProfile } from './contextBuilder/auxiliaryRegistry'

// ── Tool groups ──────────────────────────────────────────────────────────

/** The minimal toolset for a localized code task. Always active. */
export const CORE_TOOLS = [
  SEARCH_FILES, READ_FILE, READ_LARGE_RESULT, EDIT_FILE, GLOB,
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

export type ToolsetGroupName = 'FILE_OPS' | 'SHELL' | 'WEB' | 'SUBAGENT' | 'MEMORY' | 'PROVISION'

const GROUP_TOOLS: Record<ToolsetGroupName, readonly string[]> = {
  FILE_OPS: FILE_OPS_TOOLS,
  SHELL: SHELL_TOOLS,
  WEB: WEB_TOOLS,
  SUBAGENT: SUBAGENT_TOOLS,
  MEMORY: MEMORY_TOOLS,
  PROVISION: PROVISION_TOOLS,
}

// ── Profile-bound toolsets ───────────────────────────────────────────────
//
// The Intent Router (qwen3.7-plus) classifies the user's request into a
// PromptProfile + a readOnly flag. Each profile declares:
//   - base:   the tools active on turn 1 (the smallest set the task needs)
//   - allowed: the MAXIMUM tools request_tools/model-planned groups can activate
//              for this profile (null = no bound — all tools allowed)
//
// This is what makes the tighter toolset actually bind: even if the model
// calls request_tools asking for everything, only `allowed` tools activate;
// the rest are denied. `readOnly` further intersects `allowed` with
// non-destructive tools (no edit/write/create/delete/rename) so a "deploy
// without editing" run keeps Publishing/Shell but drops file mutations.

/** Verification/audit without editing files (Parte B: read-only set). */
const READONLY_BASE = [
  READ_FILE, SEARCH_FILES, GLOB, LIST_DIRECTORY, READ_LARGE_RESULT,
  READ_SKILL, ASK_USER_QUESTION,
] as const

/** Localised bugfix — reading + execute + ask (Parte B). edit_file is
 *  intentionally OUT of the base so the model must request it explicitly;
 *  this keeps a verification-style bugfix at ~6 tools, not 8. */
const BUGFIX_BASE = [
  READ_FILE, SEARCH_FILES, GLOB, READ_LARGE_RESULT, EXECUTE_COMMAND,
  ASK_USER_QUESTION,
] as const
/** Exported for tests + the usage-log to reference the bugfix base set. */
export { BUGFIX_BASE, READONLY_BASE }

/**
 * Tools that mutate the filesystem — stripped when readOnly is true.
 * Exported so the agent loop can track whether any file mutation occurred
 * during a run (the "stopped without editing" guardrail in query.ts).
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
  EDIT_FILE, WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
])

/**
 * The FULL set stripped when readOnly is true: destructive file tools +
 * provisioning (creates cloud resources) + shell/dev-server/background
 * (can mutate via commands). A read-only run is pure inspection — read,
 * search, list, ask — nothing that changes state. `execute_command`
 * (synchronous, often read-only like `git log`/`ls`) is intentionally NOT
 * blocked; the analysis_readonly profile simply omits it from its base.
 */
const READONLY_BLOCKED_TOOLS = new Set<string>([
  ...DESTRUCTIVE_TOOLS,
  ...PROVISION_TOOLS,
  ...SHELL_TOOLS,
])

interface ProfileToolset {
  /** Tools active on turn 1 (filtered against the registry). */
  base: readonly string[]
  /** Maximum tools request_tools/model-planned groups can activate. null = unbounded. */
  allowed: readonly string[] | null
}

const PROFILE_TOOLSETS: Record<PromptProfile, ProfileToolset> = {
  // Hard read-only: verification/audit. request_tools can't expand beyond
  // the read set, so it's effectively a no-op (and omitted when allActive).
  analysis_readonly: { base: READONLY_BASE, allowed: READONLY_BASE },

  // Bugfix in existing files. edit_file/update_tasks/list_directory/read_skill
  // are request_tools-expandable; provision/shell/destructive-create are NOT.
  bugfix_local: {
    base: BUGFIX_BASE,
    allowed: [...BUGFIX_BASE, EDIT_FILE, UPDATE_TASKS, LIST_DIRECTORY, READ_SKILL],
  },

  // UI/design work — needs edit + create/write for components.
  frontend_ui: {
    base: [...BUGFIX_BASE, EDIT_FILE],
    allowed: [...BUGFIX_BASE, EDIT_FILE, UPDATE_TASKS, LIST_DIRECTORY, READ_SKILL, CREATE_FILE, WRITE_FILE],
  },

  // New project — broad toolset, unbounded (needs everything to scaffold).
  scaffold_project: { base: [...BUGFIX_BASE, EDIT_FILE, WRITE_FILE, CREATE_FILE], allowed: null },

  // Deploy/publish — Publishing + shell + read. Unbounded, but readOnly
  // strips destructive file tools so "deploy without editing" holds.
  deploy_publish: { base: [...BUGFIX_BASE, ...PROVISION_TOOLS, ...SHELL_TOOLS], allowed: null },

  // Auth/database — provisioning + read. Unbounded.
  auth_database: { base: [...BUGFIX_BASE, ...PROVISION_TOOLS], allowed: null },

  // Image/attachment — web fetch + read. Unbounded.
  vision: { base: [...BUGFIX_BASE, WEB_FETCH], allowed: null },

  // Fallback (shouldn't normally be classified) — full CORE.
  core: { base: CORE_TOOLS, allowed: null },
}

// ── Meta-tool: request_tools ─────────────────────────────────────────────

export const REQUEST_TOOLS_NAME = 'request_tools'

// ── Meta-tool: request_context (on-demand auxiliary context) ────────────
//
// Parallel to request_tools, but for SYSTEM-PROMPT SECTIONS rather than tool
// definitions. When the context planner omits a domain/capability context
// from the system prompt, this meta-tool lets the agent fetch the omitted
// content on demand. The agentService bridge intercepts calls to this name
// and returns the auxiliary's text as a tool_result; the toolExecutor never
// sees it. Only injected when at least one auxiliary was omitted.
export const REQUEST_CONTEXT_NAME = 'request_context'

export function requestContextDefinition(omittedIds: string[]): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: REQUEST_CONTEXT_NAME,
      description:
        'Request a domain/capability context that was OMITTED from the system prompt to keep it lean. ' +
        'Use the smallest specific context first (for example design_system.semantic_tokens, agent_runtime.mcp_routing, delivery.dev_server, delivery.git_status). ' +
        'Use broad project/full contexts only when specific contexts are insufficient. ' +
        'The content is returned as a tool result for you to use this turn. ' +
        'Call ONCE per auxiliary; do not re-request one already returned.',
      parameters: {
        type: 'object',
        properties: {
          auxiliary: {
            type: 'string',
            description:
              'Auxiliary id to load. Available on-demand: ' +
              (omittedIds.length > 0
                ? omittedIds.join(', ')
                : '(none — all context is already loaded)'),
          },
        },
        required: ['auxiliary'],
      },
    },
  }
}

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
  /**
   * Tool names the model asked for but were DENIED because they fall outside
   * the profile's `allowed` set (or are destructive while readOnly). These
   * never activate — the bound is what keeps a bugfix at ~6 tools instead of
   * the model pulling all 31 via request_tools.
   */
  denied: string[]
}

/**
 * Stateful toolset selector. One per agent run. Expands monotonically —
 * once a tool is activated it never leaves the active set, so the tool-schema
 * prefix stabilises and prompt-caching can reuse it.
 */
export class ToolsetSelector {
  /** Names of tools that are currently active (starts with the profile base). */
  private activeToolNames: Set<string>
  /** All available tool names (from the toolExecutor registry). */
  private allToolNames: Set<string>
  /**
   * Maximum tools that can EVER be active for this run (the profile's
   * `allowed` set, intersected with non-destructive when readOnly). null = no
   * bound. request_tools, model-planned groups, and defensive expandForToolName
   * all refuse to activate names outside this set.
   */
  private allowedToolNames: Set<string> | null
  /** The profile driving base + allowed. */
  private profile: PromptProfile
  /** Read-only hint from the Intent Router (strips destructive tools). */
  private readOnly: boolean
  /**
   * Names activated via request_tools across the whole run (monotonic) —
   * exposed for the usage log so an export proves what was expanded and when.
   */
  private expandedNames = new Set<string>()
  /** Names the model requested but were DENIED by the profile bound (monotonic). */
  private deniedNames = new Set<string>()
  /**
   * Number of auxiliary context blocks omitted from the system prompt (set by
   * agentService after building the prompt). When > 0, selectForTurn injects
   * the `request_context` meta-tool so the agent can fetch omitted context.
   */
  private omittedAuxiliaryCount = 0

  constructor(
    allToolNames: string[],
    profile: PromptProfile = 'bugfix_local',
    readOnly = false,
    plannedGroups: ToolsetGroupName[] = [],
  ) {
    this.allToolNames = new Set(allToolNames)
    this.profile = profile
    this.readOnly = readOnly
    this.allowedToolNames = this.resolveAllowed(profile, readOnly)
    // Start with the profile's base — only keep names that exist in the
    // registry AND are inside the allowed bound.
    const base = PROFILE_TOOLSETS[profile]?.base ?? CORE_TOOLS
    this.activeToolNames = new Set(
      base.filter((n) => this.allToolNames.has(n) && this.isAllowed(n)),
    )
    for (const group of plannedGroups) {
      this.activateGroup(group)
    }
  }

  /**
   * Resolve the allowed set for a profile + readOnly. null means unbounded
   * (the profile permits all tools). readOnly ALWAYS strips the
   * READONLY_BLOCKED set (destructive + provision + shell/dev-server/
   * background): when allowed is null, the ceiling becomes allToolNames
   * minus blocked; when allowed is a list, it's intersected with non-blocked.
   */
  private resolveAllowed(profile: PromptProfile, readOnly: boolean): Set<string> | null {
    const ts = PROFILE_TOOLSETS[profile]
    if (!ts) return null
    let allowed: readonly string[] | null = ts.allowed
    if (readOnly) {
      if (allowed === null) {
        // Unbounded profile + readOnly: ceiling = all tools minus blocked.
        return new Set(
          Array.from(this.allToolNames).filter((n) => !READONLY_BLOCKED_TOOLS.has(n)),
        )
      }
      allowed = allowed.filter((n) => !READONLY_BLOCKED_TOOLS.has(n))
    }
    return allowed === null ? null : new Set(allowed)
  }

  /** Whether a name is inside the allowed bound (or unbounded). */
  private isAllowed(name: string): boolean {
    if (this.allowedToolNames === null) return true
    return this.allowedToolNames.has(name)
  }

  /**
   * Set the count of omitted auxiliary context blocks. Called by agentService
   * after the system prompt is built (the count comes from the
   * auxiliaryRegistry selection). Drives request_context meta-tool injection.
   */
  setOmittedAuxiliaries(count: number): void {
    this.omittedAuxiliaryCount = Math.max(0, count)
  }

  /** Names of auxiliaries omitted (for the request_context description). */
  private omittedAuxiliaryIds: string[] = []
  setOmittedAuxiliaryIds(ids: string[]): void {
    this.omittedAuxiliaryIds = ids
  }

  private activateGroup(group: ToolsetGroupName): void {
    for (const name of GROUP_TOOLS[group]) {
      if (this.allToolNames.has(name) && this.isAllowed(name)) {
        this.activeToolNames.add(name)
      }
    }
  }

  /**
   * Select the active tools for this turn. No local text matching happens
   * here; up-front expansion must come from the model-produced context/tool
   * plan, and later expansion must come from request_tools or a defensive
   * expandForToolName call.
   *
   * @param allTools  All tool definitions from the toolExecutor.
   */
  selectForTurn(
    allTools: OpenAI.ChatCompletionTool[],
    _userText = '',
  ): ToolsetSelection {
    // Build the filtered list, preserving the original order.
    const activeTools = allTools.filter((t) =>
      this.activeToolNames.has(t.function.name),
    )

    // allActive means every ALLOWED tool is active (not every tool in the
    // registry — when a bound is in place, the bound is the ceiling).
    const ceiling = this.allowedToolNames ?? this.allToolNames
    const allActive = this.activeToolNames.size >= ceiling.size
    // Meta-tools: request_tools (when tools are omitted) + request_context
    // (when auxiliary context blocks are omitted). Both can coexist; each is
    // only injected when there's something to request.
    const tools: OpenAI.ChatCompletionTool[] = [...activeTools]
    if (!allActive) tools.push(this.buildRequestToolsMetaTool())
    if (this.omittedAuxiliaryCount > 0) {
      tools.push(this.buildRequestContextMetaTool())
    }

    return {
      tools,
      activeCount: this.activeToolNames.size,
      totalCount: this.allToolNames.size,
      allActive,
    }
  }

  /**
   * Activate specific tool names (called by the request_tools meta-tool bridge).
   * Returns which were newly added, already active, unknown, or DENIED
   * (outside the profile's allowed bound — never activated).
   */
  requestTools(toolNames: string[]): RequestToolsResult {
    const added: string[] = []
    const alreadyActive: string[] = []
    const unknown: string[] = []
    const denied: string[] = []
    for (const name of toolNames) {
      if (!this.allToolNames.has(name)) {
        unknown.push(name)
      } else if (!this.isAllowed(name)) {
        // The model asked for a tool the profile forbids — deny it. This is
        // the bound that stops a bugfix from pulling all 31 tools.
        denied.push(name)
        this.deniedNames.add(name)
      } else if (this.activeToolNames.has(name)) {
        alreadyActive.push(name)
      } else {
        this.activeToolNames.add(name)
        this.expandedNames.add(name)
        added.push(name)
      }
    }
    return { added, alreadyActive, unknown, denied }
  }

  /** Names activated via request_tools so far this run (monotonic). */
  getExpandedNames(): string[] {
    return Array.from(this.expandedNames)
  }

  /** Names the model requested but the profile bound denied (monotonic). */
  getDeniedNames(): string[] {
    return Array.from(this.deniedNames)
  }

  /** Record a denied direct tool call (not via request_tools) for telemetry. */
  noteDeniedToolName(toolName: string): void {
    if (this.allToolNames.has(toolName) && !this.isAllowed(toolName)) {
      this.deniedNames.add(toolName)
    }
  }

  /** The profile driving this run's toolset. */
  getProfile(): PromptProfile {
    return this.profile
  }

  /** Whether the run is read-only (no destructive file tools). */
  isReadOnly(): boolean {
    return this.readOnly
  }

  /**
   * Activate a single tool by name (defensive: called when the executor
   * receives a call for a tool that exists but isn't active). Refuses to
   * activate tools outside the allowed bound; returns false in that case so
   * the caller can surface a proper error instead of silently expanding.
   */
  expandForToolName(toolName: string): boolean {
    if (!this.allToolNames.has(toolName) || !this.isAllowed(toolName)) {
      return false
    }
    if (!this.activeToolNames.has(toolName)) {
      this.activeToolNames.add(toolName)
      return true
    }
    return false
  }

  /** Whether a tool name is currently in the active set. */
  isActive(toolName: string): boolean {
    return this.activeToolNames.has(toolName)
  }

  /** Build the request_tools meta-tool listing only the ALLOWED-but-inactive
   *  names. When a bound is in place, tools outside the bound are deliberately
   *  hidden from the description so the model doesn't waste a turn asking for
   *  them (and getting denied). */
  private buildRequestToolsMetaTool(): OpenAI.ChatCompletionTool {
    const inactive: string[] = []
    for (const name of this.allToolNames) {
      if (this.activeToolNames.has(name)) continue
      if (this.isAllowed(name)) inactive.push(name)
    }
    return requestToolsDefinition(inactive)
  }

  /** Build the request_context meta-tool with the omitted auxiliary ids. */
  private buildRequestContextMetaTool(): OpenAI.ChatCompletionTool {
    return requestContextDefinition(this.omittedAuxiliaryIds)
  }
}
