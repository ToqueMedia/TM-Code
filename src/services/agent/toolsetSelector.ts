/**
 * Dynamic toolset selection — sends only the tools the current task needs
 * instead of all 36 definitions on every request.
 *
 * WHY THIS EXISTS
 * ─────────────
 * Every turn of the agent loop re-sends the full tool catalog as JSON schemas.
 * Dozens of tools × ~300 tokens each ≈ 10K+ tokens of tool-definitions overhead on
 * EVERY request — even a one-line bugfix that only needs read_file + edit_file.
 * That's ~10K tokens billed as input on every turn, inflating cost and context
 * pressure for no value.
 *
 * HOW IT WORKS
 * ────────────
 * The selector starts with the model-selected profile base and optional
 * model-planned tool groups. Additional tools are delivered on demand when
 * the model asks for them. On-demand activations are PERSISTENT for the rest
 * of the run (2026-07-13; they used to be transient — sent for one model step
 * and then dropped unless re-requested). Transience looked thrifty but cost
 * more than it saved: the `tools` array is part of the provider's cacheable
 * prefix, so add-then-remove churned the prefix on EVERY step after an
 * activation (cache miss ≫ the ~300 tokens of one schema), and the model had
 * to burn request_tools round-trips re-asking for a tool it had already been
 * granted. A run's toolset now only GROWS, which keeps the prefix stable
 * between activations. claude-vaz behaves the same way: its tool pool is
 * fixed within a run.
 *
 * Expansion sources:
 *   1. Context/tool plan from the utility model activates groups up front.
 *   2. The agent calls the `request_tools` meta-tool explicitly → activates
 *      the named tools for the next model step.
 *   3. The toolExecutor receives a call for a tool that exists in the registry
 *      but isn't active → activates it (defensive: covers model hallucination
 *      of a tool name it read about in the system prompt).
 *
 * Profiles are not authorization bounds. If a registered tool is requested,
 * the selector delivers it unless a hard policy applies, such as an explicit
 * developer no-edit/read-only instruction.
 */

import type OpenAI from 'openai'
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
  REQUEST_CREDENTIALS, LSP,
} from './toolNames'
import type { PromptProfile } from './contextBuilder/auxiliaryRegistry'

// ── Tool groups ──────────────────────────────────────────────────────────

/** The minimal toolset for a localized code task. Always active. */
export const CORE_TOOLS = [
  GREP_ALIAS, READ_ALIAS, GLOB_ALIAS, LS_ALIAS,
  SEARCH_FILES, READ_FILE, READ_AROUND, READ_LARGE_RESULT, EDIT_FILE, GLOB, LSP,
  EXECUTE_COMMAND, ASK_USER_QUESTION, UPDATE_TASKS, UPDATE_SESSION_MEMORY,
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
export const MEMORY_TOOLS = [
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY,
  UPDATE_SESSION_MEMORY, READ_SESSION_MEMORY,
] as const

/**
 * Credential-collection tools (developer-owned third-party env vars).
 * Platform provisioning (provision_auth/database/files/deploy) was removed
 * from the IDE agent's toolset — this IDE is a pure dev tool; the managed
 * layer lives in TM Code Web. `request_credentials` stays: it collects the
 * developer's OWN third-party keys (LLM, payments, email, …), which is core.
 */
export const PROVISION_TOOLS = [
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

// ── Profile starter toolsets ─────────────────────────────────────────────
//
// The Intent Router (qwen3.7-plus) classifies the user's request into a
// PromptProfile + a readOnly hint. Each profile declares only the tools that
// should be active on the first model step. request_tools/model-planned groups
// may activate any registered tool later; profile selection is a cost/context
// optimisation, not an authorization boundary.

/** Verification/audit without editing files (Parte B: read-only set). */
const READONLY_BASE = [
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
  READ_FILE, READ_AROUND, SEARCH_FILES, GLOB, LIST_DIRECTORY, READ_LARGE_RESULT, LSP,
  // Shell no perfil read-only DE PROPÓSITO: perguntas de verificação
  // ("qual é o username do admin?") muitas vezes respondem-se pelo ESTADO
  // real (consultar a BD, git log, node -e), não pelo código — o claude-vaz
  // resolve-as assim em 2 chamadas. Comandos perigosos continuam a pedir
  // autorização e as tools destrutivas de ficheiros continuam bloqueadas
  // pelo gate DESTRUCTIVE_TOOLS.
  EXECUTE_COMMAND,
  READ_SKILL, ASK_USER_QUESTION, UPDATE_SESSION_MEMORY,
] as const

/** Project bootstrap for TMS.md: inspect focused files, then write only the
 *  project profile. No shell by default. */
const PROJECT_BOOTSTRAP_BASE = [
  LS_ALIAS, GLOB_ALIAS, GREP_ALIAS, READ_ALIAS,
  LIST_DIRECTORY, GLOB, SEARCH_FILES, READ_FILE, READ_AROUND, WRITE_FILE, CREATE_FILE,
  ASK_USER_QUESTION, UPDATE_SESSION_MEMORY,
] as const

/** Localised bugfix — reading + execute + ask (Parte B). edit_file is
 *  intentionally OUT of the base so the model must request it explicitly;
 *  this keeps a verification-style bugfix at ~6 tools, not 8. */
const BUGFIX_BASE = [
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
  READ_FILE, READ_AROUND, SEARCH_FILES, GLOB, READ_LARGE_RESULT, LSP, EXECUTE_COMMAND,
  ASK_USER_QUESTION, UPDATE_SESSION_MEMORY,
] as const
/** Exported for tests + the usage-log to reference the bugfix base set. */
export { BUGFIX_BASE, READONLY_BASE }

/**
 * Tools that mutate the filesystem.
 * Exported so the agent loop can track whether any file mutation occurred
 * during a run (the "stopped without editing" guardrail in query.ts).
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
  EDIT_FILE, WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
])

/**
 * The FULL set stripped only when read-only enforcement is hard. Most
 * readOnly classifications are hints from the router/planner and should not
 * deny on-demand tools. A hard lock is reserved for explicit developer
 * no-edit/read-only instructions. `execute_command` (synchronous, often
 * read-only like `git log`/`ls`) is intentionally NOT blocked.
 */
const READONLY_BLOCKED_TOOLS = new Set<string>([
  ...DESTRUCTIVE_TOOLS,
  ...PROVISION_TOOLS,
  ...SHELL_TOOLS,
])

interface ProfileToolset {
  /** Tools active on turn 1 (filtered against the registry). */
  base: readonly string[]
}

const PROFILE_TOOLSETS: Record<PromptProfile, ProfileToolset> = {
  // Visible /init-like project profiling for TMS.md. execute_command is not
  // available by default; request_tools may still activate it if needed.
  project_bootstrap: {
    base: PROJECT_BOOTSTRAP_BASE,
  },

  // Verification/audit starter set. Hard no-edit enforcement is controlled by
  // the constructor flag, not by this profile.
  analysis_readonly: { base: READONLY_BASE },

  // Bugfix in existing files. edit_file/update_tasks/list_directory/read_skill
  // are not active by default; any registered tool can be requested on demand.
  bugfix_local: {
    base: BUGFIX_BASE,
  },

  // UI/design work — needs edit + create/write for components.
  frontend_ui: {
    base: [...BUGFIX_BASE, EDIT_FILE],
  },

  // New project — broad starter set (needs everything to scaffold).
  scaffold_project: { base: [...BUGFIX_BASE, EDIT_FILE, WRITE_FILE, CREATE_FILE] },

  // Deploy/publish — shell + credentials + read.
  deploy_publish: { base: [...BUGFIX_BASE, ...PROVISION_TOOLS, ...SHELL_TOOLS] },

  // Auth/database — credentials + read.
  auth_database: { base: [...BUGFIX_BASE, ...PROVISION_TOOLS] },

  // Image/attachment — web fetch + read.
  vision: { base: [...BUGFIX_BASE, WEB_FETCH] },

  // Fallback (shouldn't normally be classified) — full CORE.
  core: { base: CORE_TOOLS },
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
        'Use the smallest specific context first (for example design_system.semantic_tokens, agent_runtime.mcp_routing, delivery.dev_server, delivery.git_status, project.docs_full for README/PLAN/TODO). ' +
        'TMS.md is already in the system prompt when the project has one — do not re-request it. ' +
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
        '(e.g. write_file, create_file, delegate, save_memory). ' +
        'The requested tools stay available for the remainder of this run — never re-request a tool already granted. ' +
        'Call this ONCE with all the tools you need — do not call it repeatedly ' +
        'for individual tools. After calling this, wait for its tool result, then continue in the same run ' +
        'using the activated tools on the next model step. Do not stop or defer the task just because you requested tools.',
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
  /** Tool names denied by a hard policy such as explicit read-only/no-edit. */
  denied: string[]
}

/**
 * Stateful toolset selector. One per agent run. Profile/base tools persist
 * through the run; tools requested on demand ALSO persist to the end of the
 * run (the active set only grows) — see the module header for why transience
 * was removed (prompt-cache churn + re-request round-trips).
 */
export class ToolsetSelector {
  /** Names of tools currently active for the next request. */
  private activeToolNames: Set<string>
  /** Names that belong to the current profile/planned starter set. */
  private persistentToolNames: Set<string>
  /** All available tool names (from the toolExecutor registry). */
  private allToolNames: Set<string>
  /** The profile driving the starter toolset. */
  private profile: PromptProfile
  /** Read-only hint from the Intent Router / context plan. Telemetry only. */
  private readOnlyHint: boolean
  /** Hard no-edit policy from an explicit developer instruction. */
  private enforceReadOnly: boolean
  /**
   * Names activated on demand across the whole run. This is audit history;
   * it does not mean those tools are still active.
   */
  private expandedNames = new Set<string>()
  /** Names the model requested but were denied by a hard policy. */
  private deniedNames = new Set<string>()
  /**
   * Instrumentação (payloadInspector): nº de chamadas request_tools e de
   * ativações defensivas nesta run. request_tools frequente = perfil mal
   * calibrado (o starter set não tinha o que a tarefa pedia) e cada chamada
   * custa um round-trip; ativações defensivas = o modelo chamou um tool
   * inativo diretamente (recuperado sem round-trip extra, mas é o mesmo
   * sinal de miss do perfil).
   */
  private requestToolsCallCount = 0
  private defensiveExpansionCount = 0
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
    enforceReadOnly = readOnly,
  ) {
    this.allToolNames = new Set(allToolNames)
    this.profile = profile
    this.readOnlyHint = readOnly
    this.enforceReadOnly = enforceReadOnly
    this.persistentToolNames = new Set()
    this.activeToolNames = new Set()
    this.resetPersistentTools(profile, plannedGroups)
  }

  /**
   * Switch the active task profile inside the same run. Used only after the
   * project_bootstrap phase has produced TMS.md, so the original user task can
   * continue with its normal task toolset.
   */
  switchProfile(
    profile: PromptProfile,
    readOnly = false,
    plannedGroups: ToolsetGroupName[] = [],
    enforceReadOnly = readOnly,
  ): void {
    this.profile = profile
    this.readOnlyHint = readOnly
    this.enforceReadOnly = enforceReadOnly
    this.resetPersistentTools(profile, plannedGroups)
  }

  private resetPersistentTools(profile: PromptProfile, plannedGroups: ToolsetGroupName[]): void {
    // Deliberate: a profile switch (only used post-bootstrap) DROPS on-demand
    // activations from the previous phase — the new profile's base defines a
    // fresh starting set for the actual task.
    this.persistentToolNames = new Set()
    const base = PROFILE_TOOLSETS[profile]?.base ?? CORE_TOOLS
    for (const name of base) {
      if (this.canActivate(name)) this.persistentToolNames.add(name)
    }
    for (const group of plannedGroups) {
      this.activateGroup(group)
    }
    this.activeToolNames = new Set(this.persistentToolNames)
  }

  private isBlockedByHardPolicy(name: string): boolean {
    return this.enforceReadOnly && READONLY_BLOCKED_TOOLS.has(name)
  }

  private canActivate(name: string): boolean {
    return this.allToolNames.has(name) && !this.isBlockedByHardPolicy(name)
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
      if (this.canActivate(name)) {
        this.persistentToolNames.add(name)
      }
    }
  }

  private getRequestableToolNames(): Set<string> {
    return new Set(
      Array.from(this.allToolNames).filter((name) => !this.isBlockedByHardPolicy(name)),
    )
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

    const requestable = this.getRequestableToolNames()
    const allActive = Array.from(requestable).every((name) => this.activeToolNames.has(name))
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
   * Returns which were newly added, already active, unknown, or denied by a
   * hard policy. Registered tools are otherwise delivered on demand.
   */
  requestTools(toolNames: string[]): RequestToolsResult {
    this.requestToolsCallCount++
    const added: string[] = []
    const alreadyActive: string[] = []
    const unknown: string[] = []
    const denied: string[] = []
    for (const name of toolNames) {
      if (!this.allToolNames.has(name)) {
        unknown.push(name)
      } else if (this.isBlockedByHardPolicy(name)) {
        denied.push(name)
        this.deniedNames.add(name)
      } else if (this.activeToolNames.has(name)) {
        alreadyActive.push(name)
      } else {
        this.activeToolNames.add(name)
        // Persistente até ao fim da run — ver cabeçalho do módulo (churn de
        // prompt cache + round-trips de re-request mataram a transiência).
        this.persistentToolNames.add(name)
        this.expandedNames.add(name)
        added.push(name)
      }
    }
    return { added, alreadyActive, unknown, denied }
  }

  /** Names activated on demand so far this run (audit trail, not active set). */
  getExpandedNames(): string[] {
    return Array.from(this.expandedNames)
  }

  /** Names the model requested but hard policy denied (audit trail). */
  getDeniedNames(): string[] {
    return Array.from(this.deniedNames)
  }

  /** Record a denied direct tool call (not via request_tools) for telemetry. */
  noteDeniedToolName(toolName: string): void {
    if (this.allToolNames.has(toolName) && this.isBlockedByHardPolicy(toolName)) {
      this.deniedNames.add(toolName)
    }
  }

  /** The profile driving this run's toolset. */
  getProfile(): PromptProfile {
    return this.profile
  }

  /** Whether a hard explicit no-edit/read-only policy is enforced. */
  isReadOnly(): boolean {
    return this.enforceReadOnly
  }

  /** Router/planner read-only classification, kept as a hint for telemetry. */
  getReadOnlyHint(): boolean {
    return this.readOnlyHint
  }

  /**
   * Activate a single tool by name (defensive: called when the executor
   * receives a call for a registered tool that isn't active). Refuses only
   * unknown names or hard-policy-blocked names.
   */
  expandForToolName(toolName: string): boolean {
    if (!this.canActivate(toolName)) {
      return false
    }
    if (!this.activeToolNames.has(toolName)) {
      this.activeToolNames.add(toolName)
      this.persistentToolNames.add(toolName)
      this.expandedNames.add(toolName)
      this.defensiveExpansionCount++
      return true
    }
    return false
  }

  /**
   * Estatísticas de instrumentação para o payloadInspector — indicador
   * direto de perfis mal calibrados: calls>0 significa que o starter set
   * não chegou e a run pagou round-trips de request_tools.
   */
  getInstrumentationStats(): {
    requestToolsCalls: number
    defensiveActivations: number
    expandedNames: string[]
    deniedNames: string[]
  } {
    return {
      requestToolsCalls: this.requestToolsCallCount,
      defensiveActivations: this.defensiveExpansionCount,
      expandedNames: Array.from(this.expandedNames),
      deniedNames: Array.from(this.deniedNames),
    }
  }

  /** Whether a tool name is currently in the active set. */
  isActive(toolName: string): boolean {
    return this.activeToolNames.has(toolName)
  }

  /** Build the request_tools meta-tool listing registered inactive names that
   *  are not blocked by a hard explicit policy. */
  private buildRequestToolsMetaTool(): OpenAI.ChatCompletionTool {
    const inactive: string[] = []
    for (const name of this.allToolNames) {
      if (this.activeToolNames.has(name)) continue
      if (!this.isBlockedByHardPolicy(name)) inactive.push(name)
    }
    return requestToolsDefinition(inactive)
  }

  /** Build the request_context meta-tool with the omitted auxiliary ids. */
  private buildRequestContextMetaTool(): OpenAI.ChatCompletionTool {
    return requestContextDefinition(this.omittedAuxiliaryIds)
  }
}
