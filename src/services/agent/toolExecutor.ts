import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useProjectStore } from '../../stores/projectStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import FirebaseAuthService from '../auth/firebaseAuth'
import { PUBLISHING_SKILL_NAME } from './skillService'
import {
  FORBIDDEN_FIREBASE_AUTH_NAMES,
  FORBIDDEN_DATA_LAYER_DEPS,
  FORBIDDEN_ITK_V2_PATH,
  FORBIDDEN_SERVICE_ACCOUNT_KEY,
  FRONTEND_BUILD_SCRIPT_PATTERNS,
  DOCKERFILE_ANTI_PATTERNS,
  DOCKERFILE_PATH,
  REJECTION_REASONS,
} from './forbiddenPatterns'
import { tauriFetch } from '../tauriFetch'
import { devServerManager } from '../devServerManager'
import { resolveWorkerUrl, resolveDeployUrl } from '../../utils/devUrls'
import { formatError } from '../../utils/errors'
import { checkPlanModeAccess, isPlanArtefactAtRoot } from './planMode'
// TypeScriptLspService removed — get_diagnostics now uses npx tsc directly
import CheckpointService from './checkpointService'
import type { MCPTool } from '../mcp/mcpService'
import type { AgentCallbacks } from './agentService'
import { useChatStore } from '../../stores/chatStore'

// === Types ===

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /**
   * True iff this tool can run in parallel with other concurrency-safe tools
   * without risking races or correctness bugs. Read-only operations
   * (read_file, list_directory, glob, web_fetch, etc.) are safe. Anything that
   * mutates the filesystem, spawns processes, or mutates agent state is not.
   *
   * Default: false (serial). Used by safeToolPool to gate parallel execution.
   * Not sent to the API — getToolDefinitions() only copies name/description/parameters.
   */
  concurrencySafe?: boolean
  /**
   * True iff this tool is handled server-side by the AI provider (e.g.
   * DashScope native web_search). The frontend registers the schema so
   * the model can call it, but no execute handler runs locally. If the
   * provider doesn't handle it, a skip notice is returned.
   *
   * Default: false (local execution). Not sent to the API.
   */
  passive?: boolean
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

interface ToolEntry {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>) => Promise<string>
}

// === Abort helpers ===

/**
 * Create a child AbortController linked to an optional parent signal.
 * When the parent fires, the child fires too. If the parent is already
 * aborted at call time, the child is aborted immediately.
 *
 * Used by research, verify, and spawn_background_agent to propagate
 * the per-call abort signal to sub-agent loops without duplicating the
 * 5-line linking pattern at each call site.
 */
function createLinkedAbortController(parentSignal?: AbortSignal): AbortController {
  const child = new AbortController()
  if (parentSignal) {
    if (parentSignal.aborted) {
      child.abort()
    } else {
      parentSignal.addEventListener('abort', () => child.abort(), { once: true })
    }
  }
  return child
}

// ── Platform-managed credential gate ────────────────────────────────
//
// `request_credentials` rejects fields whose IDs match any of these names —
// those credentials live ONLY on the TM Code worker / are written by
// provision_auth / provision_deploy. Asking the developer for them shows a
// dialog they cannot satisfy. The auth-proxy skill (hard rule #2) and the
// publish-backend skill both forbid this in prose; this is the mechanical
// enforcement after a real session (sess_1778931389233_p1v9ao, 2026-05-16)
// where the model fell back to request_credentials after provision_auth
// returned a soft-failure string. Lists current TM_* names + every legacy
// name still written by provision_auth for backward-compat.
const PLATFORM_MANAGED_FIELD_IDS = new Set<string>([
  // Canonical TM_* names (written by provision_auth)
  'TM_AUTH_KEY', 'VITE_TM_AUTH_KEY',
  'TM_AUTH_DOMAIN', 'VITE_TM_AUTH_DOMAIN',
  'TM_PROJECT_ID', 'VITE_TM_PROJECT_ID',
  'TM_TENANT_ID', 'VITE_TM_TENANT_ID',
  'VITE_TM_GOOGLE_CLIENT_ID',
  // Legacy mirrors (dual-written by provision_auth for old projects)
  'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID', 'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MEASUREMENT_ID',
  'VITE_GIP_TENANT_ID', 'VITE_GOOGLE_CLIENT_ID',
  'GIP_FIREBASE_API_KEY', 'GIP_TENANT_ID', 'GIP_PROJECT_ID', 'GCP_PROJECT_ID',
  // Deploy / data layer (written by provision_deploy or never user-supplied)
  'APP_ID', 'FIREBASE_PROJECT_ID', 'FIREBASE_APP_ID',
  'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  // Database — the platform DB is reached via runtime IAM, no URL/key
  'DATABASE_URL', 'FIRESTORE_EMULATOR_HOST',
])

function describePlatformManagedField(id: string): string | null {
  if (!PLATFORM_MANAGED_FIELD_IDS.has(id)) return null
  return (
    `Blocked: "${id}" is a PLATFORM-MANAGED credential — never request it via this form. ` +
    `It is written automatically by provision_auth (auth/GIP credentials) or provision_deploy (deploy/DB credentials), ` +
    `not collected from the developer.\n\n` +
    `If you reached for request_credentials because provision_auth FAILED, that is the wrong recovery path. ` +
    `provision_auth failure means the platform tenant could not be created — the credential simply doesn't exist yet. ` +
    `Asking the developer to type it in cannot succeed; the developer has no way to obtain it themselves.\n\n` +
    `Correct recovery:\n` +
    `  1. Stop the auth implementation.\n` +
    `  2. Tell the developer in chat that provision_auth failed and report the exact error message it returned.\n` +
    `  3. Ask the developer whether to retry provision_auth or skip the auth feature entirely.\n` +
    `Do NOT continue scaffolding auth code that depends on these credentials.`
  )
}

// === Tool Executor ===

class ToolExecutor {
  private static instance: ToolExecutor
  private tools: Map<string, ToolEntry> = new Map()
  /** Tracks when files were last read by the model — for read-before-write enforcement.
   *  Stores timestamp + a simple content hash to detect concurrent modifications. */
  private readFileTimestamps: Map<string, { timestamp: number; hash: number }> = new Map()
  /**
   * CMD mode CWD — when set, the executor operates like Claude Code CLI:
   * no project required, file writes go directly to disk (no diff/approval),
   * and path validation is scoped to this directory instead of a project root.
   */
  private cmdModeCwd: string | null = null

  /**
   * Plan mode — when true, /plan is active and only architecture-producing
   * tools may run. Implementation tools (provision_auth, request_credentials,
   * execute_command, start_dev_server, install commands) are blocked at
   * execute() entry with an instructive error so the model is forced back
   * onto producing PLAN.md. Belt-and-braces over the architect system prompt:
   * if a model with strong "build the thing" priors ignores the role, the
   * mechanical block returns a tool result the model cannot ignore.
   */
  private planMode: boolean = false

  /**
   * Plan-mode progress flags. Together they enforce the architect contract:
   *
   *   1. update_tasks is BLOCKED until PLAN.md is written (no task list without a plan).
   *   2. After both PLAN.md is written AND update_tasks has run once, ANY further
   *      tool call is blocked — the architect's role is complete and continuing
   *      drifts into implementation.
   *
   * Both reset to false on every enablePlanMode() so each /plan run starts clean.
   */
  private planFileWritten: boolean = false
  private planTasksSeeded: boolean = false

  private constructor() {
    this.registerTools()
  }

  static getInstance(): ToolExecutor {
    if (!ToolExecutor.instance) {
      ToolExecutor.instance = new ToolExecutor()
    }
    return ToolExecutor.instance
  }

  /** Enable CLI/CMD mode: file ops write directly to disk, no project required. */
  enableCmdMode(cwd: string): void {
    this.cmdModeCwd = cwd
  }

  /** Disable CLI/CMD mode and return to IDE diff mode. */
  disableCmdMode(): void {
    this.cmdModeCwd = null
  }

  /** Enable architect mode for /plan: implementation tools are blocked.
   *  Resets plan-progress flags so each /plan run starts clean. */
  enablePlanMode(): void {
    this.planMode = true
    this.planFileWritten = false
    this.planTasksSeeded = false
  }

  /** Restore the normal coding agent surface. */
  disablePlanMode(): void {
    this.planMode = false
    this.planFileWritten = false
    this.planTasksSeeded = false
  }

  isPlanMode(): boolean {
    return this.planMode
  }

  /** Clears session-scoped state. Call on new sessions. */
  resetSessionState(): void {
    this.readFileTimestamps.clear()
    this.largeResults.clear()
    this.largeResultCounter = 0
    this.readOnlyContexts.clear()
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`)
    }

    // Phase B: pre-check abort signal at entry. If the loop already cancelled
    // before this tool got dispatched (e.g., user hit ESC during streaming),
    // skip permission prompts and execution entirely. Tools that have
    // expensive side effects (subprocess spawn, network) check the signal
    // again mid-execution via input._abortSignal — that's their job.
    if (signal?.aborted) {
      return `Tool ${toolName} aborted before execution (user cancelled).`
    }

    // Passive tools: handled server-side by the provider (DashScope/Qwen native tools).
    // The `passive` flag on the tool definition declares this — no hardcoded Set to maintain.
    // These are defined in the tool schema so the model can call them, but the
    // provider executes them internally — the frontend never runs an execute handler.
    // When the model calls a passive tool, the provider returns results directly
    // in the API response. If we reach here, it means the model called a passive
    // tool but the provider didn't handle it (e.g., wrong model). Return a skip notice.
    if (tool.definition.passive) {
      return `Tool ${toolName} is a server-side tool managed by the AI provider. It was not executed locally. Ensure the active model supports this tool natively (e.g., Qwen 3.6 on DashScope).`
    }

    // .env files are ALWAYS blocked — read, write, edit, delete
    const filePath = (input.path || input.oldPath || '') as string
    if (this.isEnvFile(filePath) && ['read_file', 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file'].includes(toolName)) {
      return 'Blocked: .env files contain secrets and cannot be read or modified by the agent. Ask the developer what environment variables are needed, or create a .env.example with placeholder values.'
    }

    // /plan architect mode — block implementation tools so the architect role
    // cannot drift into building the project. The model's *system prompt*
    // already forbids these (see planCommand.ts:buildArchitectSystemPrompt),
    // but strong-prior models (instruction-tuned for "build the thing") have
    // been observed to call provision_auth on turn 1 anyway. The mechanical
    // block returns an instructive error the model has to read in its next
    // tool result, redirecting it back onto PLAN.md.
    if (this.planMode) {
      const planBlock = this.checkPlanModeAccess(toolName, filePath)
      if (planBlock) return planBlock

      // M4b — update_tasks must follow write_file('PLAN.md').
      // The task list mirrors PLAN.md's Implementation Phases; without a
      // written plan the tasks have no source-of-truth to derive from.
      if (toolName === 'update_tasks' && !this.planFileWritten) {
        return `Blocked in /plan architect mode: ${toolName} must follow write_file('PLAN.md'). The task list mirrors PLAN.md's Implementation Phases — write the plan first, then derive tasks from its phase structure (one task per coherent unit of work, IDs like "1.1", "1.2", "2.1" matching the phase numbering). Calling update_tasks before write_file is a contract violation.`
      }

      // M5 — Strict STOP after both PLAN.md and update_tasks have completed.
      // The architect's role is finished; any further tool call drifts into
      // implementation. The next phase (TODO generation, then execution) runs
      // in a fresh turn after the developer approves the plan card.
      if (this.planFileWritten && this.planTasksSeeded) {
        return `Blocked in /plan architect mode: PLAN.md is written and the task tracker is seeded. Your role for this turn is complete. Stop calling tools and end the turn with a 3-sentence chat summary — TODO generation runs after the developer approves the plan card.`
      }
    }

    // Sensitive files require explicit developer authorization
    const isSensitive = toolName === 'read_file' && this.isSensitiveFile(input.path as string)

    // Dangerous commands: all commands in the DANGEROUS_COMMANDS list.
    // - If BLOCKED by user in Settings → rejected immediately (never runs)
    // - If NOT blocked → always prompts Yes/No (forcePrompt bypasses Accept All)
    // - Commands NOT in the list → normal permission flow
    let dangerousAlreadyApproved = false
    if (toolName === 'execute_command') {
      const commandStr = (input.command as string) || ''
      const dangerousMatch = this.matchDangerousCommand(commandStr)
      if (dangerousMatch) {
        const { flaggedCommands } = useSettingsStore.getState()
        if (flaggedCommands.includes(dangerousMatch)) {
          return `Blocked: "${dangerousMatch}" is blocked in your Settings. The developer disabled this command. Ask the developer to unblock it in Settings > Sandbox if needed.`
        }
        // Not blocked but dangerous → always ask (forcePrompt bypasses Accept All)
        const decision = await usePermissionStore.getState().requestPermission(toolName, input, 'dangerous_command')
        this.recordPermission(toolCallId, decision)
        if (!decision.approved) {
          const reason = decision.denyReason
            ? ` User says: ${decision.denyReason}`
            : ' Ask the user what they want instead.'
          return `Permission denied by user for ${dangerousMatch}.${reason}`
        }
        dangerousAlreadyApproved = true
      }
    }

    // Agent-internal tools + tools that surface their own confirmation UI:
    // bypass the generic permission dialog. update_tasks/check_background_agents
    // are autonomous; request_credentials renders a secure form in the chat
    // (Save/Skip is the gate, not the permission dialog).
    const PERMISSION_EXEMPT_TOOLS = new Set([
      'update_tasks',
      'check_background_agents',
      'request_credentials',
    ])

    if (!dangerousAlreadyApproved && !PERMISSION_EXEMPT_TOOLS.has(toolName)) {
      const decision = await usePermissionStore.getState().requestPermission(toolName, input, isSensitive ? 'sensitive_file' : false)
      this.recordPermission(toolCallId, decision)
      if (!decision.approved) {
        const target = (input.path || input.command || input.name || '') as string
        const reason = decision.denyReason
          ? ` User says: ${decision.denyReason}`
          : ' Ask the user what they want instead or suggest an alternative approach.'
        return `Permission denied by user for ${toolName}${target ? ` (${target})` : ''}.${reason}`
      }
    }

    // Inject per-call context. Tools read these out of `input` when they
    // need them — no singleton state on ToolExecutor, so concurrent
    // invocations don't race.
    //   _toolCallId  → for checkpoint/progress reporting
    //   _abortSignal → for tools that can honor mid-flight cancellation
    //                  (execute_command, web_fetch, install commands).
    //                  Fast read-only tools just check it once at entry.
    const execInput: Record<string, unknown> = { ...input }
    if (toolCallId) execInput._toolCallId = toolCallId
    if (signal) execInput._abortSignal = signal

    const result = await tool.execute(execInput)
    // Diff results must never be truncated — the UI needs full JSON for InlineDiff,
    // and agentService needs it for approval and readFileTimestamps updates.
    try {
      const parsed = JSON.parse(result)
      if (parsed?.type === 'diff') return result
    } catch { /* not JSON — proceed to truncation */ }
    // read_large_result already produced a model-bounded slice (limit ≤ 30000) +
    // a continuation suffix. Passing it through truncateResult would nest a new
    // large_result every time the slice + suffix exceeds the 30K threshold —
    // the model then chases pagination of pagination, doubling content in
    // context and starving the output budget before write_file lands.
    if (toolName === 'read_large_result') return result
    return this.truncateResult(result)
  }

  /** Number of core (non-MCP) tools registered. */
  getCoreToolCount(): number {
    return Array.from(this.tools.keys()).filter(k => !k.startsWith('mcp__')).length
  }

  /**
   * Returns true iff the tool is safe to execute in parallel with other
   * concurrency-safe tools. Used by safeToolPool to gate parallel dispatch.
   * Unknown tools default to false (serial) — defensive.
   */
  isConcurrencySafe(toolName: string): boolean {
    return this.tools.get(toolName)?.definition.concurrencySafe === true
  }

  getToolDefinitions(): OpenAIToolDefinition[] {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function' as const,
      function: {
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.input_schema
      }
    }))
  }

  /**
   * Registers MCP tools, replacing any previously registered MCP tools.
   * Tool names use double-underscore separator: mcp__serverName__toolName
   */
  registerMCPTools(mcpTools: MCPTool[], callToolFn: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>): void {
    // Remove old MCP tools
    for (const [name] of this.tools) {
      if (name.startsWith('mcp__')) {
        this.tools.delete(name)
      }
    }

    // Register new MCP tools
    for (const tool of mcpTools) {
      const fullName = `mcp__${tool.serverName}__${tool.name}`
      // Browser tools share a single trust gate: the user already opted into
      // the /te2e command, which is itself a slash command they explicitly
      // typed. Per-action permission prompts (Antigravity-style) were tried
      // and removed — they fragmented sessions into hundreds of Y/N clicks
      // for no observable safety gain (the browser is sandboxed in its own
      // profile dir, isolated from the user's real Chrome). beginSession is
      // still called to hide the preview pane so the two webviews don't
      // compete for attention.
      const isBrowserTool = tool.serverName === 'browser'

      this.tools.set(fullName, {
        definition: {
          name: fullName,
          description: `[MCP: ${tool.serverName}] ${tool.description}`,
          input_schema: tool.inputSchema as ToolDefinition['input_schema'],
          // MCP spec annotations.readOnlyHint → safe to run in parallel with
          // other read-only tools. Defensive default: serial when unset, so
          // mutating MCP tools never accidentally race. Browser tools stay
          // serial because the model usually drives them in tight observe-
          // then-act pairs where parallelism wouldn't help anyway.
          concurrencySafe: !isBrowserTool && tool.readOnlyHint === true,
        },
        execute: async (input: Record<string, unknown>) => {
          if (isBrowserTool) {
            // Hide the user's preview before the very first browser action
            // of this turn so the two webviews don't compete for attention.
            const { browserSession } = await import('../browserSessionManager')
            await browserSession.beginSession()
          }
          return await callToolFn(tool.serverName, tool.name, input)
        },
      })
    }
  }

  /** Large result storage — maps reference IDs to full content for later retrieval. */
  private largeResults: Map<string, string> = new Map()
  private largeResultCounter = 0

  /**
   * Handles large tool results: if the result exceeds the threshold,
   * stores the full output in memory and returns a reference with a preview.
   * The model can retrieve the full output via read_large_result tool.
   * This prevents information loss from truncation (like Claude Code's disk persistence).
   */
  private truncateResult(result: string, maxChars: number = 30000): string {
    if (result.length <= maxChars) return result

    // Store full result in memory for later retrieval
    const refId = `large_result_${++this.largeResultCounter}`
    this.largeResults.set(refId, result)

    // Keep only the last 20 large results to prevent memory bloat
    if (this.largeResults.size > 20) {
      const firstKey = this.largeResults.keys().next().value
      if (firstKey) this.largeResults.delete(firstKey)
    }

    const previewSize = 2000
    const preview = result.slice(0, previewSize)
    const totalSize = result.length > 1024
      ? `${(result.length / 1024).toFixed(1)}KB`
      : `${result.length} chars`

    return `Output too large (${totalSize}). Full output stored as: ${refId}\n\nPreview (first ${previewSize} chars):\n${preview}\n...\n\nUse read_large_result("${refId}") to read a specific portion of the full output.`
  }

  /**
   * Runs install commands via streaming (run_streaming_command) so the user
   * sees real-time logs in the chat via progressText.
   * Includes a 180s timeout to prevent hanging if the process stalls.
   */
  private async executeInstallStreaming(
    command: string,
    cwd: string,
    toolCallId?: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const tcId = toolCallId
    const allOutput: string[] = []

    // Register listeners BEFORE spawning
    let targetPid = 0
    let finished = false
    let resolveExit: (code: number) => void
    const exitPromise = new Promise<number>(res => { resolveExit = res })

    const bufferedOutput: { pid: number; data: string }[] = []
    const bufferedExit: { pid: number; code: number }[] = []

    const unOutput = await listen<{ pid: number; stream: string; data: string }>(
      'cmd-output',
      (event) => {
        if (targetPid === 0) {
          bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
        } else if (event.payload.pid === targetPid) {
          this.handleInstallOutput(event.payload.data, allOutput, tcId)
        }
      }
    )

    const unExit = await listen<{ pid: number; code: number }>(
      'cmd-exit',
      (event) => {
        if (targetPid === 0) {
          bufferedExit.push({ pid: event.payload.pid, code: event.payload.code })
        } else if (event.payload.pid === targetPid && !finished) {
          finished = true
          cleanup()
          resolveExit(event.payload.code)
        }
      }
    )

    const cleanup = () => { unOutput(); unExit() }

    try {
      if (tcId) {
        useChatStore.getState().updateToolCallProgress(tcId, 'Installing dependencies...')
      }

      const pid = await invoke<number>('run_streaming_command', { command, cwd })
      targetPid = pid

      // Flush buffered events
      for (const ev of bufferedOutput) {
        if (ev.pid === pid) {
          this.handleInstallOutput(ev.data, allOutput, tcId)
        }
      }
      for (const ev of bufferedExit) {
        if (ev.pid === pid && !finished) {
          finished = true
          cleanup()
          resolveExit!(ev.code)
        }
      }

      // Race: exit vs timeout vs abort (user stops agent)
      const INSTALL_TIMEOUT = 300_000 // 5 min — large projects can be slow on first install
      let timeoutTimer: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<number>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`Install timed out after ${INSTALL_TIMEOUT / 1000}s`)), INSTALL_TIMEOUT)
      })

      // Phase B: honor the per-call abort signal threaded through `execute()`.
      // Replaces the brittle global `AgentService.getInstance().getAbortController()`
      // lookup, which couldn't distinguish parent vs sub-agent loops and
      // would race on instance reassignment. The signal is now per-call so
      // sub-agents and background agents get their own correct controller.
      const abortPromise = abortSignal
        ? new Promise<number>((_, reject) => {
            if (abortSignal.aborted) reject(new Error('aborted'))
            else abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        : new Promise<number>(() => {}) // never resolves

      let exitCode: number
      try {
        exitCode = await Promise.race([exitPromise, timeoutPromise, abortPromise]) as number
        clearTimeout(timeoutTimer!)
      } catch (raceErr) {
        clearTimeout(timeoutTimer!)
        cleanup()
        try { await invoke('kill_process', { pid: targetPid }) } catch { /* best effort */ }
        const msg = raceErr instanceof Error ? raceErr.message : String(raceErr)
        if (msg === 'aborted') {
          return `Install cancelled by user.\nExit code: 1\n\nThe install process was killed mid-execution. Dependencies in node_modules/ (or equivalent) may be partially installed or in an inconsistent state. Run the install command again to ensure all packages are correctly resolved before proceeding.`
        }
        return `TIMEOUT: ${msg}\n${allOutput.join('')}\nThe install process was killed.\n\nIMPORTANT: The install timed out. Tell the user to install dependencies manually by running the install command in the integrated terminal. Do NOT retry the install automatically.`
      }

      const fullOutput = allOutput.join('')

      if (exitCode === 0) {
        if (tcId) {
          useChatStore.getState().updateToolCallProgress(tcId, '')
        }
        // Return summary for the model
        const lines = fullOutput.split('\n')
        const tail = lines.slice(-15).join('\n')
        return `${tail}\nExit code: 0\n\nDependencies installed successfully.`
      }

      // Failure: return full output for model to diagnose
      return `${fullOutput}\nExit code: ${exitCode}`
    } catch (error) {
      cleanup()
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to install dependencies: ${msg}`
    }
  }

  private handleInstallOutput(
    data: string,
    allOutput: string[],
    toolCallId: string | null | undefined,
  ): void {
    allOutput.push(data)
    if (!toolCallId) return

    // Show the last meaningful line as progress
    const lines = data.trim().split('\n')
    const lastLine = lines[lines.length - 1] || ''
    if (lastLine.length > 0) {
      const display = lastLine.length > 80 ? lastLine.slice(0, 80) + '...' : lastLine
      useChatStore.getState().updateToolCallProgress(toolCallId, display)
    }
  }

  private detectServerUrl(output: string) {
    // Fallback path: when the agent ran a raw `execute_command` that happens
    // to start a server, pick up the URL and register it as a frontend-like
    // dev server so the preview opens. Prefer `start_dev_server` which gives
    // proper lifecycle management; this is best-effort.
    //
    // CRITICAL: skip entirely when a dev server is already active. Otherwise
    // any stray URL in command output (e.g. `curl http://localhost:7777/api`,
    // log lines with API references, build reports) would overwrite the
    // live dev server URL. This had broken fullstack preview: the agent
    // would print a backend URL mid-stream and the preview would hop to it.
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.devServer) return

    // Positive-readiness patterns ONLY — never match a bare URL in output,
    // since that catches curl calls, log lines, and docs/comments.
    const serverPatterns = [
      /Local:\s+(https?:\/\/localhost:\d+)/,
      /ready on (https?:\/\/localhost:\d+)/,
      /Server running at (https?:\/\/localhost:\d+)/,
      /listening on (https?:\/\/localhost:\d+)/,
    ]

    for (const pattern of serverPatterns) {
      const match = output.match(pattern)
      if (match) {
        const url = match[1]
        // Read again just before mutating — another tool call may have started
        // a real devServer between the early-return above and this point.
        if (useLayoutStore.getState().devServer) return
        useLayoutStore.getState().initDevServer({ pid: 0, projectKind: 'frontend' })
        useLayoutStore.getState().setDevServerFrontendUrl(url)
        useLayoutStore.getState().setViewMode('preview')
        break
      }
    }
  }

  private getProjectRoot(): string {
    if (this.cmdModeCwd) return this.cmdModeCwd
    const project = useProjectStore.getState().currentProject
    if (!project?.path) {
      throw new Error('No project is open. Cannot perform file operations without an active project.')
    }
    return project.path
  }

  private validatePathWithinProject(filePath: string): void {
    const projectRoot = this.getProjectRoot()
    // Normalize: resolve '..' segments and ensure the path is within project root
    const normalizedPath = this.normalizePath(filePath)
    const normalizedRoot = this.normalizePath(projectRoot)

    if (!normalizedPath.startsWith(normalizedRoot + '/') && normalizedPath !== normalizedRoot) {
      const label = this.cmdModeCwd ? 'working directory' : 'project directory'
      throw new Error(`Access denied: path "${filePath}" is outside the ${label}.`)
    }
  }

  private normalizePath(p: string): string {
    // Normalize separators: convert all backslashes to forward slashes (cross-platform).
    // This allows consistent comparison on Windows where paths may use \ or mixed separators.
    const unified = p.replace(/\\/g, '/')

    // Detect Windows drive letter (e.g., "C:/Users/...")
    const driveMatch = unified.match(/^([A-Za-z]):\//)
    const prefix = driveMatch ? driveMatch[1].toUpperCase() + ':/' : '/'
    const pathAfterPrefix = driveMatch ? unified.slice(3) : unified

    // Resolve '..' and '.' segments
    const parts = pathAfterPrefix.split('/')
    const resolved: string[] = []
    for (const part of parts) {
      if (part === '..') {
        resolved.pop()
      } else if (part !== '.' && part !== '') {
        resolved.push(part)
      }
    }
    return prefix + resolved.join('/')
  }

  /**
   * Suggests a similar file path when the requested path doesn't exist.
   * Checks: same basename in project (different directory), same name with
   * different extension, and basename as glob pattern.
   */
  private async suggestSimilarPath(requestedPath: string): Promise<string | null> {
    try {
      const projectRoot = this.getProjectRoot()
      const basename = requestedPath.replace(/\\/g, '/').split('/').pop() || ''
      if (!basename) return null

      // Timeout: abort suggestion if glob takes too long (large projects)
      const SUGGESTION_TIMEOUT = 2000
      const withTimeout = <T>(promise: Promise<T>): Promise<T | null> =>
        Promise.race([
          promise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), SUGGESTION_TIMEOUT)),
        ])

      // Strategy 1: Glob for same filename anywhere in project
      const exactMatches = await withTimeout(invoke<string[]>('glob_files', {
        pattern: `**/${basename}`,
        directory: projectRoot,
      }))
      if (exactMatches && exactMatches.length > 0 && exactMatches[0] !== requestedPath) {
        return exactMatches[0]
      }

      // Strategy 2: Same name, different extension (e.g., .ts vs .tsx, .js vs .jsx)
      const nameWithoutExt = basename.replace(/\.[^.]+$/, '')
      const extVariants = await withTimeout(invoke<string[]>('glob_files', {
        pattern: `**/${nameWithoutExt}.*`,
        directory: projectRoot,
      }))
      if (extVariants) {
        const filtered = extVariants.filter(p => p !== requestedPath)
        if (filtered.length > 0) {
          return filtered[0]
        }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Forbidden Firebase JS SDK auth surface — every method below either pops a
   * window (silently blocked in the IDE preview's wry/WKWebView child webview)
   * or bypasses the project's auth-proxy contract. The auth-proxy +
   * google-signin skills mandate the GIS button + /api/auth/proxy/* flow.
   *
   * This is defense-in-depth: the skill prompts forbid these in writing, but
   * the model's training prior is overwhelmingly `signInWithPopup` (most
   * Firebase tutorials use it) — without a mechanical check the prior wins
   * a non-trivial fraction of the time.
   *
   * `onAuthStateChanged` is the ONE allowed import from `firebase/auth` and
   * is excluded from the regex.
   */
  // Pattern moved to ./forbiddenPatterns — single source of truth shared
  // with the SKILL build-time verifier and any future lint hook.

  /**
   * Returns a block message if the given content imports/calls forbidden
   * Firebase auth methods, or null if it's clean. Scoped to TS/TSX/JS/JSX
   * files — markdown, JSON, and config files are unaffected.
   *
   * Path-scoped to avoid false positives in the auth-proxy itself (which
   * legitimately calls Identity Toolkit REST endpoints whose response
   * payloads mention "GoogleAuthProvider" etc. in comments).
   */
  private checkForbiddenAuthImports(path: string, content: string): string | null {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return null
    // Skip backend auth-proxy files — they legitimately hit Identity Toolkit.
    // The forbidden pattern targets CLIENT-side firebase/auth imports.
    if (/\/(server|backend|api)\/.*auth.*\.(ts|js)$/i.test(path)) return null

    const importsFromFirebaseAuth = /(?:^|\n)\s*import[\s\S]+?from\s+['"]firebase\/auth['"]\s*;?/m.test(content)
    if (!importsFromFirebaseAuth) return null

    const match = content.match(FORBIDDEN_FIREBASE_AUTH_NAMES)
    if (!match) return null

    return REJECTION_REASONS.firebaseAuthImport(path, match[1])
  }

  /**
   * Reject writes that hit `identitytoolkit.googleapis.com/v2/accounts:*`.
   * Defense-in-depth alongside the auth-proxy SKILL's `/v1` rule —
   * documented for ages but still violated under generation pressure
   * (the model has both /v1 and /v2 in training and silently picks /v2
   * ~30% of the time per the SKILL note). The runtime block forces a
   * fix before the file lands.
   *
   * Scoped to TS/JS only — README.md and prompt notes legitimately
   * mention the wrong URL when documenting the rule itself.
   */
  private checkForbiddenItkV2(path: string, content: string): string | null {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt)$/i.test(path)) return null
    if (!FORBIDDEN_ITK_V2_PATH.test(content)) return null
    return REJECTION_REASONS.itkV2Path(path)
  }

  /**
   * Reject writes that import a `serviceAccountKey.json`. The platform
   * runtime authenticates via the metadata server — there's no JSON key
   * to ship, and the file doesn't exist in the project. Catching this
   * at write time stops the agent from generating a code path that's
   * irreparable without manual intervention.
   */
  private checkForbiddenServiceAccountImport(path: string, content: string): string | null {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return null
    if (!FORBIDDEN_SERVICE_ACCOUNT_KEY.test(content)) return null
    return REJECTION_REASONS.serviceAccountKey(path)
  }

  /**
   * Reject Dockerfile writes that pair badly with the Cloud Run container
   * contract. The skill's §8 anti-patterns enumerate the specific failures
   * (frontend build script in the container, node running .ts, env-file
   * pointing at .env). Each match cites the publish-backend SKILL recovery
   * path — defense-in-depth so a Dockerfile that violates the SKILL never
   * reaches Cloud Build, where the failure mode is opaque
   * ("vite: not found", non-zero exit at step 6).
   *
   * The frontend-build-script check needs the project's package.json to
   * resolve `npm run X` → script body (X) → "is X a frontend build?".
   * We accept the project root via toolExecutor.cmdModeCwd or by walking
   * up from the Dockerfile path until package.json is found.
   */
  private async checkForbiddenDockerfileShape(path: string, content: string): Promise<string | null> {
    if (!DOCKERFILE_PATH.test(path)) return null

    // 1. Cheap pattern checks first — no I/O.
    for (const { pattern, kind } of DOCKERFILE_ANTI_PATTERNS) {
      if (!pattern.test(content)) continue
      if (kind === 'nodeRunsTs') {
        this.emitDockerfileRejection('nodeRunsTs', path, false)
        return REJECTION_REASONS.dockerfileNodeRunsTs(path)
      }
      if (kind === 'envFileInCmd') {
        this.emitDockerfileRejection('envFileInCmd', path, false)
        return REJECTION_REASONS.dockerfileEnvFileInCmd(path)
      }
    }

    // 2. The frontend-build check: needs to resolve `RUN npm run <script>`
    //    against the project's package.json to know what <script> actually
    //    runs. Skip when no `RUN npm run …` (or yarn/pnpm equivalent) is
    //    present — most Dockerfiles don't reach this branch.
    const npmRunMatch = content.match(/RUN\s+(?:npm\s+run|yarn\s+(?!run\s)|pnpm\s+run)\s+([a-z0-9:_-]+)/i)
    if (!npmRunMatch) return null
    const scriptName = npmRunMatch[1]

    // Walk up from the Dockerfile to find package.json (handles both flat
    // layout and `Dockerfile` colocated with `server/package.json`).
    const pkgPath = await this.findNearestPackageJson(path)
    if (!pkgPath) return null
    const scripts = await this.getCachedPackageScripts(pkgPath)
    if (!scripts) return null
    const scriptBody = scripts[scriptName]
    if (!scriptBody) return null

    const isFrontendBuild = FRONTEND_BUILD_SCRIPT_PATTERNS.some((p) => p.test(scriptBody))
    if (!isFrontendBuild) return null
    this.emitDockerfileRejection('frontendBuild', path, true)
    return REJECTION_REASONS.dockerfileFrontendBuild(path, scriptName, scriptBody)
  }

  /** Per-projectRoot cache of the parsed `scripts` block. The Dockerfile
   *  checker is called on every write; without this it would re-invoke
   *  `read_file` on the same package.json several times in a row during a
   *  scaffold turn (write Dockerfile → write .dockerignore → edit
   *  Dockerfile). 60s TTL is short enough that the agent's own edits to
   *  package.json invalidate naturally on the next sweep. */
  private packageJsonCache: Map<string, { scripts: Record<string, string> | null; expiresAt: number }> = new Map()

  private async getCachedPackageScripts(pkgPath: string): Promise<Record<string, string> | null> {
    const now = Date.now()
    const cached = this.packageJsonCache.get(pkgPath)
    if (cached && cached.expiresAt > now) return cached.scripts
    let raw: string
    try {
      raw = await invoke<string>('read_file', { path: pkgPath })
    } catch {
      return null
    }
    let scripts: Record<string, string> | null = null
    try {
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
      scripts = parsed?.scripts ?? null
    } catch {
      scripts = null
    }
    this.packageJsonCache.set(pkgPath, { scripts, expiresAt: now + 60_000 })
    return scripts
  }

  /** Fire-and-forget telemetry for Dockerfile rejections. Lets us answer
   *  "is the harness catching this anti-pattern in production?" — without
   *  the event we'd have no signal whether the rule is firing 5×/day
   *  (systemic) or 0×/day (resolved). Path is hashed-prefix only to keep
   *  PII out of analytics. */
  private emitDockerfileRejection(
    kind: 'nodeRunsTs' | 'envFileInCmd' | 'frontendBuild',
    path: string,
    hasFrontendBuild: boolean,
  ): void {
    import('../../services/analytics').then(({ trackEvent }) => {
      void trackEvent('dockerfile_rejected', {
        kind,
        has_frontend_build: hasFrontendBuild,
        // Last 32 chars of the path — enough to distinguish project layouts
        // (`/Dockerfile` vs `/server/Dockerfile`) without leaking the user's
        // home dir or full project name.
        path_suffix: path.slice(-32),
      })
    }).catch(() => { /* analytics never blocks writes */ })
  }

  /** Walk parent dirs from `startPath` looking for a `package.json`.
   *  Returns the absolute path or null. Bounded to 6 levels — the project
   *  root is always close to a Dockerfile in practice. */
  private async findNearestPackageJson(startPath: string): Promise<string | null> {
    let dir = startPath.slice(0, startPath.lastIndexOf('/'))
    for (let i = 0; i < 6; i++) {
      if (!dir) return null
      try {
        const candidate = `${dir}/package.json`
        await invoke<string>('read_file', { path: candidate })
        return candidate
      } catch {
        const parent = dir.slice(0, dir.lastIndexOf('/'))
        if (parent === dir) return null
        dir = parent
      }
    }
    return null
  }

  // FORBIDDEN_DATA_LAYER_DEPS moved to ./forbiddenPatterns — same module
  // hosts FORBIDDEN_FIREBASE_AUTH_NAMES + the rejection-message builders
  // so the SKILL verifier and any future lint hook share one source.

  /**
   * Reject writes to package.json that add forbidden SQL data-layer deps.
   * Triggers on create_file / write_file / edit_file when the target is
   * any package.json under the project root. Only fires when the NEW
   * content contains a forbidden dep that's NOT in the OLD content — i.e.
   * we don't block legitimate edits to existing legacy projects, only the
   * act of scaffolding the wrong shape into a fresh project.
   *
   * Returns the block message (string) when the write should be rejected,
   * null when it's allowed.
   */
  private checkForbiddenDataLayerDeps(path: string, newContent: string, oldContent: string = ''): string | null {
    if (!/(?:^|\/)package\.json$/.test(path)) return null

    let newPkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    try {
      newPkg = JSON.parse(newContent)
    } catch {
      return null // not valid JSON yet — let the user fix that issue first
    }
    let oldDeps = new Set<string>()
    if (oldContent) {
      try {
        const oldPkg = JSON.parse(oldContent) as typeof newPkg
        oldDeps = new Set([
          ...Object.keys(oldPkg.dependencies ?? {}),
          ...Object.keys(oldPkg.devDependencies ?? {}),
        ])
      } catch { /* old content malformed — treat as empty */ }
    }
    const newDeps = new Set([
      ...Object.keys(newPkg.dependencies ?? {}),
      ...Object.keys(newPkg.devDependencies ?? {}),
    ])
    const newlyAdded = FORBIDDEN_DATA_LAYER_DEPS.filter(
      (dep) => newDeps.has(dep) && !oldDeps.has(dep),
    )
    if (newlyAdded.length === 0) return null
    return REJECTION_REASONS.dataLayerDeps(path, newlyAdded)
  }

  // Files that may contain secrets — require explicit user authorization
  private static readonly SENSITIVE_FILE_PATTERNS = [
    /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
    /^\.npmrc$/,
    /\.pem$/,
    /\.key$/,
    /credentials\.json$/,
    /_secret/,
  ]

  private isEnvFile(filePath: string): boolean {
    if (!filePath) return false
    const filename = filePath.replace(/\\/g, '/').split('/').pop() || ''
    // Block all .env files EXCEPT exactly ".env.example"
    if (!filename.startsWith('.env')) return false
    return filename !== '.env.example'
  }

  /**
   * Returns a block message if the call should be denied under planMode, or
   * null if the call may proceed. Wraps the pure helper with the executor's
   * current project root.
   */
  private checkPlanModeAccess(toolName: string, filePath: string): string | null {
    return checkPlanModeAccess(toolName, filePath, this.getProjectRoot())
  }

  /**
   * Persist the permission decision onto the tool call so it surfaces in the
   * session export. Without this, forensic review can't tell whether a
   * destructive command (e.g. `kill -9`) was approved by the user or slipped
   * through unchecked — both look identical in the post-hoc markdown.
   *
   * Silent for safe tools (`source: 'safe_tool'`) — no decision was made,
   * recording it would just clutter every read_file with a permission stamp.
   */
  private recordPermission(toolCallId: string | undefined, decision: { approved: boolean; prompted: boolean; source: string; promptKind?: 'sensitive_file' | 'dangerous_command' | 'browser_action' | null; denyReason?: string }): void {
    if (!toolCallId) return
    if (decision.source === 'safe_tool') return
    // Dynamic import keeps toolExecutor free of a hard chatStore dep at module load.
    import('../../stores/chatStore').then(m => {
      m.useChatStore.getState().recordToolPermission(toolCallId, decision as NonNullable<import('../../types/chat').ToolCallDisplay['permission']>)
    }).catch(() => { /* non-critical — don't block the tool flow */ })
  }

  private isSensitiveFile(filePath: string): boolean {
    const filename = filePath.replace(/\\/g, '/').split('/').pop() || ''
    return ToolExecutor.SENSITIVE_FILE_PATTERNS.some(p => p.test(filename))
  }

  /**
   * All commands that always require explicit Yes/No approval.
   * The Settings UI imports this list directly — no separate list to maintain.
   * User can block individual commands in Settings > Sandbox > Dangerous Commands.
   *
   * IMPORTANT: this list is "needs approval", NOT "mutates state". Some entries
   * here are safe when read-only (`sudo cat`, `docker ps`, `kill -0`, `systemctl status`).
   * For state-mutation detection (used by mid-flight cancellation warnings to decide
   * whether the model should avoid auto-retrying), use STATE_MUTATING_COMMANDS below.
   */
  static readonly DANGEROUS_COMMANDS = [
    // Filesystem — destructive
    'rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'ln',
    // Filesystem — system-level
    'mkfs', 'dd', 'shutdown', 'reboot',
    // Git — risky operations
    'git push', 'git reset', 'git checkout', 'git merge', 'git rebase',
    'git stash', 'git clean', 'git commit',
    // Package managers — remove
    'npm uninstall', 'yarn remove', 'pnpm remove',
    // Process management
    'kill', 'pkill', 'killall',
    // Privilege escalation
    'sudo', 'su', 'doas', 'pkexec',
    // Network
    'wget',
    // System services
    'launchctl', 'systemctl',
  ]

  /**
   * Strict subset of DANGEROUS_COMMANDS that ACTUALLY mutate state. Used by
   * mid-flight cancellation (execute_command) to decide whether to emit the
   * strong "DO NOT auto-retry — partial side effects may exist" warning.
   *
   * Exclusions from DANGEROUS_COMMANDS (these are read-safe and require
   * approval for other reasons like privilege or network):
   *   - `sudo`, `su`, `doas`, `pkexec` — privilege wrappers; mutation depends on the wrapped command
   *   - `docker`, `docker-compose` — `docker ps`/`docker logs` are read-only
   *   - `kill`, `pkill`, `killall` — `kill -0 $PID` is a signal existence check, read-only
   *   - `wget` — downloads content but with abort mid-flight, file is incomplete not mutated
   *   - `launchctl`, `systemctl` — `list`/`status` subcommands are read-only
   *
   * WRITE_COMMAND_PATTERNS (below) covers the filesystem-mutation shell
   * patterns (redirects, sed -i, tee, etc.) that aren't caught by the
   * single-word list.
   */
  static readonly STATE_MUTATING_COMMANDS = [
    // Filesystem — unambiguously destructive
    'rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'ln',
    'mkfs', 'dd', 'shutdown', 'reboot',
    // Git — all mutate working tree or remote state
    'git push', 'git reset', 'git checkout', 'git merge', 'git rebase',
    'git stash', 'git clean', 'git commit',
    // Package managers — remove (install is handled via executeInstallStreaming with PID kill)
    'npm uninstall', 'yarn remove', 'pnpm remove',
  ]

  /**
   * Check if a command contains any dangerous command from the list.
   * Returns the matched command name, or null if not dangerous.
   */
  private matchDangerousCommand(command: string): string | null {
    return this.matchAnyInList(command, ToolExecutor.DANGEROUS_COMMANDS)
  }

  /**
   * Check if a command contains any STATE-MUTATING command (a strict subset
   * of DANGEROUS_COMMANDS — excludes sudo/docker/kill/wget/launchctl/systemctl
   * which may be read-only depending on the subcommand). Used by mid-flight
   * cancellation to decide whether the model should be warned against
   * auto-retry.
   */
  private matchStateMutatingCommand(command: string): string | null {
    return this.matchAnyInList(command, ToolExecutor.STATE_MUTATING_COMMANDS)
  }

  /** Internal: word-boundary match against a list of command tokens. */
  private matchAnyInList(command: string, list: readonly string[]): string | null {
    if (!command) return null
    const cmdLower = command.toLowerCase()
    for (const token of list) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`(?:^|[;&|\\s(\`$])${escaped}(?:\\s|$|[;&|)\`])`, 'i')
      if (pattern.test(` ${cmdLower} `)) return token
    }
    return null
  }

  /**
   * Sub-call to the worker proxy that delegates a web_search query to a
   * DashScope model with native enable_search (Qwen 3.6 Plus on the backend).
   *
   * Invoked ONLY when the current model lacks native web_search
   * (e.g. GLM-5.1). DeepSeek V3.2 and Qwen on DashScope have native search
   * and never reach this code path — the provider resolves the tool_call
   * server-side and streams the answer back directly.
   *
   * The request uses X-Request-Type: 'web_search' — the proxy forces the
   * model + enable_search based on that header (see proxy.ts).
   */
  private async runWebSearchSubCall(query: string, maxResults: number, abortSignal?: AbortSignal): Promise<string> {
    if (abortSignal?.aborted) return 'web_search aborted by user.'
    const token = await FirebaseAuthService.getInstance().getIdToken()
    if (!token) return 'web_search error: authentication required.'

    const body = {
      system: `You are a web search assistant. Use the native web_search tool to answer the user's query with up-to-date information. Return a concise summary with sources (title + URL). Do not add commentary.`,
      messages: [
        { role: 'user', content: `Search the web for: ${query}\n\nReturn up to ${maxResults} results.` },
      ],
      max_tokens: 4096,
    }

    const url = `${resolveWorkerUrl()}/v1/messages`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Request-Type': 'web_search',
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'web_search aborted by user.'
      return `web_search error: network failure (${err instanceof Error ? err.message : String(err)}).`
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return `web_search error: HTTP ${response.status}. ${detail.slice(0, 200)}`
    }

    // The worker returns an Anthropic SSE stream. We only need the final text,
    // so accumulate content_block_delta text deltas into a single string.
    const reader = response.body?.getReader()
    if (!reader) return 'web_search error: empty response body.'

    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data || data === '[DONE]') continue
          try {
            const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } }
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              answer += event.delta.text
            }
          } catch { /* ignore malformed SSE frames */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'web_search aborted by user.'
      return `web_search error: stream read failure (${err instanceof Error ? err.message : String(err)}).`
    } finally {
      try { reader.releaseLock() } catch { /* noop */ }
    }

    return answer.trim() || 'web_search returned no results.'
  }


  /**
   * Patterns that indicate file-writing operations via shell.
   * Used to enforce read-only mode for verification agents.
   */
  private static readonly WRITE_COMMAND_PATTERNS = [
    />\s*(?!\/dev\/null|&)\S/,  // redirect to file (allow > /dev/null and >&)
    />>\s*(?!\/dev\/null)\S/,   // append redirect (allow >> /dev/null)
    /\bsed\s+(-[a-zA-Z]*i|--in-place)\b/, // sed in-place edit
    /\bperl\s+(-[a-zA-Z]*i)\b/,           // perl in-place edit
    /\bmv\s+/,          // move/rename files
    /\bcp\s+/,          // copy files
    /\brm\s+/,          // remove files
    /\bmkdir\s+/,       // create directories
    /\btouch\s+/,       // create/update files
    /\btee\s+/,         // write to files via tee
    /\bchmod\s+/,       // change permissions
    /\bchown\s+/,       // change ownership
    /\bln\s+/,          // create links
    /\bcurl\s+.*-[a-zA-Z]*o\b/, // curl -o writes to file
    /\bwget\s+/,        // wget downloads files
    /\bgit\s+(add|commit|push|checkout|reset|merge|rebase|stash|tag\s+-d)\b/, // git write ops
  ]

  /**
   * Set of active read-only execution contexts (by ID).
   * When non-empty, execute_command blocks file-writing shell operations.
   * Uses a Set instead of a boolean to support concurrent verification agents
   * without one agent's cleanup disabling another's protection.
   */
  private readOnlyContexts: Set<string> = new Set()

  /** Enter read-only mode for a specific execution context. Returns the context ID. */
  enterReadOnlyMode(): string {
    const id = `ro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.readOnlyContexts.add(id)
    return id
  }

  /** Exit read-only mode for a specific execution context. */
  exitReadOnlyMode(id: string): void {
    this.readOnlyContexts.delete(id)
  }

  /** Whether any read-only context is active. */
  private get readOnlyMode(): boolean {
    return this.readOnlyContexts.size > 0
  }

  /**
   * Update the read state for a file after it has been written (diff approved).
   * Prevents false "file modified since read" errors when the model edits
   * a file it just wrote. Called by agentService after diff approval.
   */
  updateReadStateAfterWrite(path: string, newContent: string): void {
    this.readFileTimestamps.set(path, {
      timestamp: Date.now(),
      hash: this.simpleHash(newContent),
    })
    // Bump the global filesystem fingerprint. Cache keys that include it
    // (system prompt, skills) miss on the next read so the IDE sees the
    // real post-write state. Path-agnostic by design — see fsVersion.ts.
    import('../fsVersion').then(m => m.bumpFsVersion(`write:${path}`)).catch(() => { /* non-critical */ })
    // Invalidate scaffolding detector cache when files that change scaffold
    // state are written. Without this, the badge / smart-router / system-
    // prompt section would lag the agent's own writes by up to the cache TTL
    // (3s) — short, but observable when the agent finishes a scaffolding
    // turn and the developer immediately tries to type a hashtag. Covers:
    //   - package.json (payments deps)
    //   - auth-proxy / authClient / useGoogleSignIn marker files
    // .env writes are funneled through write_env_vars (which has its own
    // invalidation hook in provision_auth) so we don't include .env here —
    // the agent's write_file path can't reach it (mechanical block).
    if (/(^|\/)package\.json$|(^|\/)(auth-proxy|authClient|useGoogleSignIn)\.(ts|tsx|js)$/.test(path)) {
      const root = this.getProjectRoot()
      if (root) {
        import('../scaffoldingDetector').then(m => m.invalidateScaffoldingCache(root)).catch(() => { /* non-critical */ })
      }
    }
    // Plan-mode progress: PLAN.md at the project root unblocks update_tasks
    // and enables the strict-STOP guard once update_tasks has also run.
    if (this.planMode && isPlanArtefactAtRoot(path, this.getProjectRoot())) {
      const basename = path.replace(/\\/g, '/').split('/').pop()
      if (basename === 'PLAN.md') this.planFileWritten = true
    }
  }

  /** Fast non-cryptographic hash for concurrent modification detection. */
  private simpleHash(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return hash
  }

  private validateCommand(command: string): void {
    // Read-only mode: block file-writing shell operations (verification agents).
    // Allow common test/lint/typecheck commands even if they contain patterns
    // that look like writes (e.g., npm test may use internal redirects).
    if (this.readOnlyMode) {
      // Strip common prefixes that don't affect read/write nature: cd ../ &&, env VAR=val, etc.
      const strippedCmd = command.replace(/^\s*(cd\s+\S+\s*&&\s*)+/, '').replace(/^\s*([\w]+=\S+\s+)+/, '').trim()
      // Allowlist: commands that are safe diagnostic operations
      const isAllowedDiagnostic = /^(npm\s+(test|run\s+(test|lint|typecheck|check|tsc|build))|npx\s+(tsc|eslint|jest|vitest|mocha|next\s+lint)|pnpm\s+(test|run\s+(test|lint|typecheck|check|tsc|build))|yarn\s+(test|run\s+(test|lint|typecheck|check|tsc|build))|bun\s+(test|run\s+(test|lint|typecheck|check|tsc|build))|ng\s+(test|lint|build)|curl\s|cat\s|head\s|tail\s|wc\s|grep\s|rg\s|find\s|ls\s|echo\s)/.test(strippedCmd)
      if (!isAllowedDiagnostic) {
        for (const pattern of ToolExecutor.WRITE_COMMAND_PATTERNS) {
          if (pattern.test(command)) {
            throw new Error(`Command blocked: "${command}" would modify files, but you are running in read-only verification mode. Only diagnostic commands (tests, linters, type checkers, curl) are allowed.`)
          }
        }
      }
    }
  }

  private refreshFileTree() {
    useFileTreeRepository.getState().refresh()
  }

  private closeEditorIfOpen(path: string) {
    const editorState = useEditorRepository.getState()
    if (editorState.openFiles.some(f => f.path === path)) {
      editorState.closeFile(path)
    }
  }

  private formatFileTreeCompact(node: Record<string, unknown>, indent: string = ''): string {
    if (!node) return ''
    let result = ''
    const name = (node.name || node.fileName || '') as string
    const isDir = node.type === 'directory' || (node.children !== undefined)
    if (name) {
      result += `${indent}${isDir ? name + '/' : name}\n`
    }
    if (node.children && Array.isArray(node.children)) {
      const childIndent = name ? indent + '  ' : indent
      for (const child of node.children) {
        result += this.formatFileTreeCompact(child, childIndent)
      }
    }
    return result || '(empty directory)'
  }

  private registerTools() {
    // === read_file ===
    this.tools.set('read_file', {
      definition: {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to read' }
          },
          required: ['path']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const filePath = input.path as string
        this.validatePathWithinProject(filePath)
        try {
          const content = await invoke<string>('read_file', { path: filePath })
          const newHash = this.simpleHash(content)

          // Detect external modification BEFORE overwriting the stored
          // timestamp. If the file's content hash differs from what we
          // saw on the previous read — and the agent itself didn't write
          // through our tools in between (write_file / edit_file update
          // this map on success) — something else touched the file
          // (formatter, git pull, manual edit, dev server output). Inject
          // a system-reminder INSIDE the tool result so the model sees
          // it in the same turn the read completes. Same shape as
          // claude-vaz FileReadTool.ts:706-730.
          const prev = this.readFileTimestamps.get(filePath)
          const externalChange = prev !== undefined && prev.hash !== newHash

          // Track read timestamp + content hash for read-before-write enforcement.
          // Set AFTER the externalChange comparison so the comparison uses the
          // truly-previous state.
          this.readFileTimestamps.set(filePath, { timestamp: Date.now(), hash: newHash })

          // Empty file: the model often assumes a non-empty file when none
          // was returned and proceeds to "modify" by writing whole files.
          // The reminder makes the empty-ness explicit before the next turn.
          if (content.length === 0) {
            return '<system-reminder>The file exists but the contents are empty.</system-reminder>'
          }

          if (externalChange) {
            const reminder =
              '<system-reminder>The contents of this file have changed since you last read it '
              + '(external modification — a formatter, git pull, dev server output, or manual edit '
              + 'touched it). Treat the content below as authoritative; assumptions from the previous '
              + 'read are stale and any planned edit must be reconciled against this new content.'
              + '</system-reminder>\n\n'
            return reminder + content
          }

          return content
        } catch (error) {
          // formatError handles Tauri's plain-object throws — the previous
          // `String(error)` could yield "[object Object]" which both swallowed
          // the not-found heuristic AND surfaced uselessly to the model.
          const msg = formatError(error)
          if (/not found|no such file|does not exist/i.test(msg)) {
            const suggestion = await this.suggestSimilarPath(filePath)
            const projectRoot = this.getProjectRoot()
            let enriched = `File not found: ${filePath}\nNote: your current working directory is ${projectRoot}`
            if (suggestion) {
              enriched += `\nDid you mean: ${suggestion}`
            }
            return enriched
          }
          // Re-throw with a real Error so the safeToolPool catch sees a usable
          // shape (and the formatError fallback there matches what we logged).
          throw new Error(`read_file failed for ${filePath}: ${msg}`)
        }
      }
    })

    // === list_directory ===
    this.tools.set('list_directory', {
      definition: {
        name: 'list_directory',
        description: 'List the contents of a directory. Returns a file tree with names and types.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the directory to list' },
            maxDepth: { type: 'number', description: 'Maximum depth to traverse. Default: 3' }
          },
          required: ['path']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        const filter = { showHidden: false, maxDepth: (input.maxDepth as number) || 3 }
        const tree = await invoke('build_file_tree', { rootPath: input.path, filter })
        return this.formatFileTreeCompact(tree as Record<string, unknown>)
      }
    })

    // === search_files ===
    this.tools.set('search_files', {
      definition: {
        name: 'search_files',
        description: 'Search for text patterns across files in a directory using ripgrep. Returns up to 50 matching lines with file paths and line numbers. If you need more results, narrow your search with includePatterns.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search pattern (text or regex)' },
            directory: { type: 'string', description: 'Absolute path to search directory' },
            caseSensitive: { type: 'boolean', description: 'Case sensitive search. Default: false' },
            useRegex: { type: 'boolean', description: 'Interpret query as regex. Default: false' },
            includePatterns: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to include (e.g., ["*.tsx", "*.ts"])' }
          },
          required: ['query', 'directory']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.directory as string)
        const options = {
          case_sensitive: (input.caseSensitive as boolean) || false,
          whole_word: false,
          use_regex: (input.useRegex as boolean) || false,
          include_patterns: (input.includePatterns as string[]) || [],
          exclude_patterns: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
          max_results: 50
        }
        const result = await invoke('search_in_files', {
          query: input.query,
          directory: input.directory,
          options
        })
        return JSON.stringify(result, null, 2)
      }
    })

    // === write_file ===
    this.tools.set('write_file', {
      definition: {
        name: 'write_file',
        description: 'Replace the entire content of an existing file, or create a new file. Always read_file first on existing files to understand what you are replacing. For creating new files, prefer create_file. For small edits (1–20 lines), prefer edit_file instead.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to write' },
            content: { type: 'string', description: 'Complete content to write to the file' }
          },
          required: ['path', 'content']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        const path = input.path as string
        const newContent = input.content as string

        // Mechanical blocks on prompt-rule violations the model commits
        // anyway under generation pressure. Each check has an inline
        // comment explaining the recurring failure mode it catches.
        // Order: cheapest checks first (regex on string) before the
        // package.json parse.
        const authBlock = this.checkForbiddenAuthImports(path, newContent)
        if (authBlock) return authBlock
        const itkBlock = this.checkForbiddenItkV2(path, newContent)
        if (itkBlock) return itkBlock
        const saBlock = this.checkForbiddenServiceAccountImport(path, newContent)
        if (saBlock) return saBlock
        const dockerfileBlock = await this.checkForbiddenDockerfileShape(path, newContent)
        if (dockerfileBlock) return dockerfileBlock

        // Read current content to generate diff data
        let oldContent = ''
        let isNewFile = true
        try {
          oldContent = await invoke<string>('read_file', { path })
          isNewFile = false
        } catch {
          isNewFile = true
        }

        const dataLayerBlock = this.checkForbiddenDataLayerDeps(path, newContent, oldContent)
        if (dataLayerBlock) return dataLayerBlock

        // Enforce read-before-write for existing files (like Claude Code).
        // The model must read a file before overwriting it to understand what it's replacing.
        if (!isNewFile) {
          const readState = this.readFileTimestamps.get(path)
          if (!readState) {
            return `Error: You must read_file("${path}") before overwriting it. Read the file first to understand its current content, then call write_file.`
          }
          // Concurrent modification detection: check if file changed on disk since the model read it
          const currentHash = this.simpleHash(oldContent)
          if (currentHash !== readState.hash) {
            this.readFileTimestamps.delete(path)
            return `Error: File "${path}" has been modified since you last read it (by the developer, a formatter, or another process). Read it again with read_file before writing.`
          }
        }

        // CMD mode: write directly to disk, no approval needed — but still
        // return diff JSON so the UI renders the before/after like in chat mode.
        // `alreadyApplied: true` tells chatStore to skip the approval queue.
        if (this.cmdModeCwd) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir) await invoke('create_directories_all', { path: dir })
          await invoke('write_file', { path, content: newContent })
          this.readFileTimestamps.set(path, { timestamp: Date.now(), hash: this.simpleHash(newContent) })
          this.refreshFileTree()
          return JSON.stringify({
            type: 'diff',
            path,
            oldContent,
            newContent,
            isNewFile,
            alreadyApplied: true,
          })
        }

        // Return diff data as JSON for inline display
        // The file is NOT written yet — user approves via InlineDiff
        return JSON.stringify({
          type: 'diff',
          path,
          oldContent,
          newContent,
          isNewFile,
        })
      }
    })

    // === create_file ===
    this.tools.set('create_file', {
      definition: {
        name: 'create_file',
        description: 'Create a new file with optional content. Fails if the file already exists.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path for the new file' },
            content: { type: 'string', description: 'Initial content for the file. Default: empty' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        const path = input.path as string
        const content = (input.content as string) || ''

        // Mechanical blocks — see write_file for the rationale.
        const authBlock = this.checkForbiddenAuthImports(path, content)
        if (authBlock) return authBlock
        const itkBlock = this.checkForbiddenItkV2(path, content)
        if (itkBlock) return itkBlock
        const saBlock = this.checkForbiddenServiceAccountImport(path, content)
        if (saBlock) return saBlock
        const dockerfileBlock = await this.checkForbiddenDockerfileShape(path, content)
        if (dockerfileBlock) return dockerfileBlock
        const dataLayerBlock = this.checkForbiddenDataLayerDeps(path, content)
        if (dataLayerBlock) return dataLayerBlock

        // Check if file already exists
        try {
          await invoke<string>('read_file', { path })
          return `Error: File already exists: ${path}. Use write_file to overwrite or edit_file for small changes.`
        } catch {
          // File doesn't exist — good, proceed
        }

        // CMD mode: write directly to disk, still return diff JSON so the UI
        // renders the new file content. `alreadyApplied` skips approval queue.
        if (this.cmdModeCwd) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir) await invoke('create_directories_all', { path: dir })
          await invoke('write_file', { path, content })
          this.readFileTimestamps.set(path, { timestamp: Date.now(), hash: this.simpleHash(content) })
          this.refreshFileTree()
          return JSON.stringify({
            type: 'diff',
            path,
            oldContent: '',
            newContent: content,
            isNewFile: true,
            alreadyApplied: true,
          })
        }

        // Return diff data as JSON for inline display (consistent with write_file)
        return JSON.stringify({
          type: 'diff',
          path,
          oldContent: '',
          newContent: content,
          isNewFile: true,
        })
      }
    })

    // === create_directory ===
    this.tools.set('create_directory', {
      definition: {
        name: 'create_directory',
        description: 'Create a directory and all necessary parent directories.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the directory to create' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        await invoke('create_directories_all', { path: input.path })
        this.refreshFileTree()
        return `Directory created successfully: ${input.path}`
      }
    })

    // === delete_file ===
    this.tools.set('delete_file', {
      definition: {
        name: 'delete_file',
        description: 'Delete a file or directory. A checkpoint is created automatically so the user can undo if needed. Only use when the user explicitly asks to delete, or when removing a file you just created in error.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to delete' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)

        // Capture checkpoint before deleting. Use injected _toolCallId so
        // concurrent invocations don't race a shared field.
        const tcId = input._toolCallId as string | undefined
        if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: input.path as string })
            await CheckpointService.getInstance().captureBeforeDelete(
              input.path as string,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // File might be a directory or unreadable — skip checkpoint
          }
        }

        this.closeEditorIfOpen(input.path as string)
        await invoke('delete_file_or_directory', { path: input.path })
        this.refreshFileTree()
        // Deletes are filesystem mutations too — bump the version so the
        // next system-prompt build sees the file tree without the gone path.
        import('../fsVersion').then(m => m.bumpFsVersion(`delete:${input.path}`)).catch(() => {})
        return `Deleted successfully: ${input.path}`
      }
    })

    // === rename_file ===
    this.tools.set('rename_file', {
      definition: {
        name: 'rename_file',
        description: 'Rename a file or directory.',
        input_schema: {
          type: 'object',
          properties: {
            oldPath: { type: 'string', description: 'Current absolute path' },
            newName: { type: 'string', description: 'New name (not full path, just the name)' }
          },
          required: ['oldPath', 'newName']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.oldPath as string)
        // Validate newName doesn't contain path traversal
        const newName = input.newName as string
        if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
          throw new Error('Access denied: new name cannot contain path separators or "..".')
        }

        // Capture checkpoint before renaming. Use injected _toolCallId so
        // concurrent invocations don't race a shared field.
        const tcId = input._toolCallId as string | undefined
        if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: input.oldPath as string })
            const oldPathStr = input.oldPath as string
            const parentDir = oldPathStr.substring(0, oldPathStr.lastIndexOf('/'))
            const newPath = `${parentDir}/${newName}`
            await CheckpointService.getInstance().captureBeforeRename(
              oldPathStr,
              newPath,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // File might be a directory — skip checkpoint
          }
        }

        await invoke('rename_file_or_directory', {
          oldPath: input.oldPath,
          newName
        })
        this.refreshFileTree()
        import('../fsVersion').then(m => m.bumpFsVersion(`rename:${input.oldPath}`)).catch(() => {})
        return `Renamed successfully: ${input.oldPath} -> ${newName}`
      }
    })

    // === edit_file ===
    this.tools.set('edit_file', {
      definition: {
        name: 'edit_file',
        description: 'Replace a specific string in a file with new content. The old_str must match exactly and appear only once in the file. Use this for surgical edits instead of rewriting entire files with write_file.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to edit' },
            old_str: { type: 'string', description: 'Exact string to find and replace. Must be unique in the file.' },
            new_str: { type: 'string', description: 'String to replace old_str with. Use empty string to delete.' }
          },
          required: ['path', 'old_str', 'new_str']
        }
      },
      execute: async (input) => {
        const path = input.path as string
        const oldStr = input.old_str as string
        const newStr = input.new_str as string

        if (!oldStr) {
          return 'Error: old_str cannot be empty. Provide the exact text you want to replace.'
        }

        this.validatePathWithinProject(path)

        // Mechanical blocks on the new fragment — covers partial edits
        // that introduce forbidden code without rewriting the file.
        const authBlock = this.checkForbiddenAuthImports(path, newStr)
        if (authBlock) return authBlock
        const itkBlock = this.checkForbiddenItkV2(path, newStr)
        if (itkBlock) return itkBlock
        const saBlock = this.checkForbiddenServiceAccountImport(path, newStr)
        if (saBlock) return saBlock
        const dockerfileBlock = await this.checkForbiddenDockerfileShape(path, newStr)
        if (dockerfileBlock) return dockerfileBlock

        // Enforce read-before-edit: the model must have read the file to know what to edit
        const readState = this.readFileTimestamps.get(path)
        if (!readState) {
          return `Error: You must read_file("${path}") before editing it. Read the file first to see the current content, then call edit_file.`
        }

        const content = await invoke<string>('read_file', { path })

        // Concurrent modification detection
        const currentHash = this.simpleHash(content)
        if (currentHash !== readState.hash) {
          this.readFileTimestamps.delete(path)
          return `Error: File "${path}" has been modified since you last read it. Read it again with read_file before editing.`
        }

        const occurrences = content.split(oldStr).length - 1

        if (occurrences === 0) {
          return `Error: old_str not found in ${path}. The content you're trying to replace doesn't exist in the file. Read the file first to see the current content.`
        }

        if (occurrences > 1) {
          return `Error: old_str appears ${occurrences} times in ${path}. It must be unique. Include more surrounding context to make it unique.`
        }

        const newContent = content.replace(oldStr, newStr)

        // Mechanical block on forbidden SQL data-layer deps in package.json.
        // Edits that add Prisma/SQLite/Drizzle to a package.json get rejected.
        const dataLayerBlock = this.checkForbiddenDataLayerDeps(path, newContent, content)
        if (dataLayerBlock) return dataLayerBlock

        // CMD mode: write directly to disk, still return diff JSON so the UI
        // renders the before/after. `alreadyApplied` skips approval queue.
        if (this.cmdModeCwd) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir) await invoke('create_directories_all', { path: dir })
          await invoke('write_file', { path, content: newContent })
          this.readFileTimestamps.set(path, { timestamp: Date.now(), hash: this.simpleHash(newContent) })
          this.refreshFileTree()
          return JSON.stringify({
            type: 'diff',
            path,
            oldContent: content,
            newContent,
            isNewFile: false,
            alreadyApplied: true,
          })
        }

        // Return diff data as JSON for inline display
        return JSON.stringify({
          type: 'diff',
          path,
          oldContent: content,
          newContent,
          isNewFile: false,
        })
      }
    })

    // === glob ===
    this.tools.set('glob', {
      definition: {
        name: 'glob',
        description: 'Find files matching a glob pattern. Returns a list of absolute file paths.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.tsx", "src/**/*.test.ts", "**/package.json")' },
            directory: { type: 'string', description: 'Absolute path to search from. Default: project root' }
          },
          required: ['pattern']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const pattern = input.pattern as string
        const directory = (input.directory as string) || this.getProjectRoot()

        this.validatePathWithinProject(directory)

        const result = await invoke<string[]>('glob_files', {
          pattern,
          directory
        })

        if (result.length === 0) {
          return `No files found matching pattern: ${pattern}`
        }

        return result.join('\n')
      }
    })

    // === web_search ===
    // Two execution paths, chosen by the current model:
    //   - DeepSeek V3.2 / Qwen on DashScope: native enable_search — the provider
    //     executes internally and returns results in the stream. The frontend
    //     NEVER receives a tool_call, so execute() is not invoked for these.
    //   - GLM-5.1 (or any non-native model): execute() runs and side-cars the
    //     query to Qwen 3.6 Plus via X-Request-Type: 'web_search'. The backend
    //     forces the model + enable_search and streams the answer back.
    this.tools.set('web_search', {
      definition: {
        name: 'web_search',
        description: 'Search the internet for up-to-date information. Returns search results with titles, snippets, URLs, and metadata. Use this to look up documentation, find solutions to errors, research technical topics, or get current information.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
            max_results: { type: 'number', description: 'Maximum number of results. Default: 5' },
          },
          required: ['query']
        },
        concurrencySafe: true,
      },
      execute: async (input: Record<string, unknown>) => {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if (!query) return 'web_search error: query is required.'
        const maxResults = typeof input.max_results === 'number' ? input.max_results : 5
        const abortSignal = input._abortSignal as AbortSignal | undefined
        return await this.runWebSearchSubCall(query, maxResults, abortSignal)
      }
    })

    // === web_fetch ===
    this.tools.set('web_fetch', {
      definition: {
        name: 'web_fetch',
        description: 'Fetch the contents of a web URL. Returns the text content of the page. Use this to read documentation, check API endpoints, look up package information on npm, or research technical topics. Cannot access localhost or internal URLs.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch (must be http or https)' },
            maxLength: { type: 'number', description: 'Maximum characters to return. Default: 50000' }
          },
          required: ['url']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const url = input.url as string
        const maxLength = (input.maxLength as number) || 50000
        const signal = input._abortSignal as AbortSignal | undefined

        const firebaseAuth = FirebaseAuthService.getInstance()
        const idToken = await firebaseAuth.getIdToken()

        if (!idToken) {
          return 'Error: Not authenticated. Cannot fetch web content.'
        }

        const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'

        const callWebFetch = async (token: string) =>
          tauriFetch(`${workerUrl}/v1/web-fetch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ url, maxLength }),
            signal,
          })

        let response: Awaited<ReturnType<typeof tauriFetch>>
        try {
          response = await callWebFetch(idToken)
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return `Web fetch cancelled by user (${url}).`
          }
          throw err
        }

        // 401 retry with a force-refreshed token — covers the case where the
        // SDK's cached token was stale (e.g. wake-from-sleep). Mirrors the
        // same pattern used in agentService for /v1/chat/completions.
        if (response.status === 401) {
          const refreshed = await firebaseAuth.getIdToken(true)
          if (refreshed) {
            try {
              response = await callWebFetch(refreshed)
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') {
                return `Web fetch cancelled by user (${url}).`
              }
              throw err
            }
          }
        }

        if (!response.ok) {
          return `Error: Failed to fetch ${url} (status: ${response.status})`
        }

        const result = await response.json() as {
          url: string
          status: number
          content: string
          truncated: boolean
          error?: string
        }

        if (result.error) {
          return `Error fetching ${url}: ${result.error}`
        }

        let output = `URL: ${result.url}\nStatus: ${result.status}\n\n${result.content}`

        if (result.truncated) {
          output += '\n\n[Content was truncated to fit context window]'
        }

        return output
      }
    })

    // === execute_command ===
    this.tools.set('execute_command', {
      definition: {
        name: 'execute_command',
        description: 'Execute a shell command in the project directory. Blocks until the command exits or the timeout is reached — do NOT use for dev servers or watchers (they never exit). Use for running tests, installing dependencies, building, linting, or short-lived CLI operations. Returns stdout, stderr, and exit code. Default timeout: 120 seconds.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute (e.g., "pnpm install", "pnpm test", "ls -la")' },
            cwd: { type: 'string', description: 'Working directory. Default: project root' },
            timeout_secs: { type: 'number', description: 'Timeout in seconds. Default: 120. Max: 600.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const cmd = (input.command as string).trim()
        this.validateCommand(cmd)

        // Scope cwd to project root
        const projectRoot = this.getProjectRoot()
        const cwd = (input.cwd as string) || projectRoot
        this.validatePathWithinProject(cwd)

        // Detect package-manager install commands so they get the streaming
        // execution path (real-time logs in chat + PID-based cancellation).
        // We no longer skip repeated installs — npm/yarn/pnpm/bun are all
        // idempotent (they only mutate node_modules when something changed),
        // and the prior skip-memo caused false positives that masked real
        // installs. Trust the package manager.
        const normalizedCmd = cmd.replace(/\s+/g, ' ')
        const directInstall = normalizedCmd.match(/^((?:npm|yarn|pnpm|bun)\s+(?:install|ci|add|remove|uninstall))\b/)
          || normalizedCmd.match(/^(pip\s+install)\b/)
        const compoundInstall = !directInstall
          ? normalizedCmd.match(/^cd\s+(\S+)\s*&&\s*((?:npm|yarn|pnpm|bun)\s+(?:install|ci|add|remove|uninstall))\b/)
          : null
        const isInstallCmd = directInstall !== null || compoundInstall !== null

        const callSignal = input._abortSignal as AbortSignal | undefined

        if (isInstallCmd) {
          return this.executeInstallStreaming(
            cmd,
            cwd,
            input._toolCallId as string | undefined,
            callSignal,
          )
        }

        // Agent default: 120s. Clamp to max 600s.
        const timeoutSecs = Math.min(Number(input.timeout_secs) || 120, 600)

        // Phase B caveat: short execute_command does NOT have PID-based
        // cancellation. The Tauri `execute_command` invoke is fire-and-forget
        // from JS — once it starts on the Rust side, we cannot kill it.
        //
        // We race it against the abort signal so the agent loop returns
        // immediately on user ESC, but the Rust-side command continues until
        // natural completion or its timeoutSecs limit. The cancellation
        // message below makes this dangerous-state explicit so the model
        // does NOT blindly retry — partial side effects (file writes, network
        // calls) may have already happened.
        //
        // For true mid-execution kill, install commands use the streaming
        // path which DOES expose a PID and call kill_process via the
        // existing executeInstallStreaming infrastructure.
        const invokePromise = invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean }>('execute_command', {
          command: cmd,
          cwd,
          timeoutSecs,
        })

        // Critical: catch any late rejection from invokePromise so an aborted
        // race doesn't leave an unhandled promise rejection on the event loop.
        // Without this, when the abort race wins and we return the cancellation
        // string, invokePromise stays pending and may eventually reject — that
        // rejection has no handler and surfaces as "Uncaught (in promise)".
        invokePromise.catch(() => { /* discarded — abort race won */ })

        let result: { stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean }
        if (callSignal) {
          try {
            result = await Promise.race([
              invokePromise,
              new Promise<never>((_, reject) => {
                callSignal.addEventListener(
                  'abort',
                  () => reject(new Error('aborted')),
                  { once: true },
                )
              }),
            ])
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg === 'aborted') {
              // R2-5 / R3-2: tune the cancellation message to the command's
              // risk profile. Strong "DO NOT retry" only when the command
              // actually mutates state. Uses STATE_MUTATING_COMMANDS (strict
              // subset of DANGEROUS_COMMANDS that excludes sudo/docker/kill/
              // wget/launchctl/systemctl — those require approval for other
              // reasons like privilege or network, but may be read-only
              // depending on the subcommand). Plus WRITE_COMMAND_PATTERNS
              // for shell-level writes (redirects, sed -i, tee, etc.).
              //
              // Read-safe examples (get the light message):
              //   pnpm test, tsc --noEmit, eslint src, grep foo .,
              //   sudo cat /etc/passwd, docker ps, kill -0 $PID,
              //   systemctl status nginx, wget -q -O /dev/null url
              //
              // Mutating examples (get the strong message):
              //   rm -rf node_modules, mv foo bar, git push,
              //   npm uninstall react, echo x > file, sed -i 's/a/b/' f
              const isMutating = this.matchStateMutatingCommand(cmd) !== null
              const hasWritePattern = ToolExecutor.WRITE_COMMAND_PATTERNS.some(p => p.test(cmd))
              const couldMutate = isMutating || hasWritePattern

              const truncated = cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd
              if (couldMutate) {
                // Strong wording: partial side effects may exist; ask first.
                return `Command CANCELLED by user mid-execution: ${truncated}\nExit code: 1\n\nWARNING: this command can mutate state (matches a state-mutating pattern or write operation). The Rust subprocess could not be killed cleanly — it may still be running in the background until natural completion or its ${timeoutSecs}s timeout. Any partial side effects (file writes, mv/rm, package mutations) MAY have already occurred.\n\nDO NOT auto-retry. Ask the user what they observed before deciding the next step.`
              }
              // Light wording: command is read-only, safe for the model to
              // retry or move on without user dialogue.
              return `Command cancelled by user: ${truncated}\nExit code: 1\n\nThe command was non-mutating (read-only / diagnostic). Safe to retry if needed, or move on.`
            }
            throw err
          }
        } else {
          result = await invokePromise
        }

        if (result.timedOut) {
          return `TIMEOUT: Command exceeded ${timeoutSecs}s limit and was terminated.\nFor long-running processes, use start_dev_server instead.\nSTDERR:\n${result.stderr}`
        }

        let output = ''
        if (result.stdout) output += result.stdout
        if (result.stderr) output += `\nSTDERR:\n${result.stderr}`
        output += `\nExit code: ${result.exitCode}`

        // Detect dev server URL in output
        this.detectServerUrl(output)

        return output
      }
    })

    // === start_dev_server ===
    this.tools.set('start_dev_server', {
      definition: {
        name: 'start_dev_server',
        description: 'Start the project\'s dev server as a background process. Returns immediately — the correct preview panel opens automatically when the server is ready. ONE dev server per project.\n\nPass the command that runs the WHOLE project (e.g. "npm run dev" — even if it fans out frontend+backend via concurrently, workspaces, or turbo).\n\nproject_kind: "frontend" (UI-only → iframe preview), "backend" (API-only → HTTP Client panel), "fullstack" (both — iframe + toggleable HTTP Client drawer). Auto-detected if omitted.\n\nPorts: the framework picks the port (Vite=5173, Next=3000, Express=whatever your scripts bind). The IDE detects the URL from log output and classifies frontend/backend by HTTP content-type — you do not need to pass any port.\n\nfrontend_port_hint is OPTIONAL: pass it ONLY if both servers happen to respond with the same content-type and the IDE assigned the wrong URL to the iframe. Most projects do not need it.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Dev server command (e.g., "npm run dev", "pnpm start", "npx vite"). Pass the top-level command even if it spawns multiple processes.' },
            project_kind: { type: 'string', enum: ['frontend', 'backend', 'fullstack'], description: '"frontend", "backend", or "fullstack". Auto-detected if omitted.' },
            frontend_port_hint: { type: 'number', description: 'Optional override for fullstack content-type ambiguity. Treats the URL on this port as frontend regardless of what it serves. Use only when the automatic content-type classifier picks the wrong URL.' },
            server_type: { type: 'string', enum: ['frontend', 'backend'], description: 'DEPRECATED — use project_kind instead.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const command = input.command as string
        let projectKind = input.project_kind as 'frontend' | 'backend' | 'fullstack' | undefined
        const legacyServerType = input.server_type as 'frontend' | 'backend' | undefined
        const explicitHint = typeof input.frontend_port_hint === 'number' ? input.frontend_port_hint : undefined
        this.validateCommand(command)
        const projectRoot = this.getProjectRoot()

        // Legacy server_type maps to the new project_kind
        if (!projectKind && legacyServerType) {
          projectKind = legacyServerType
        }

        // Infer from project files if still not provided
        if (!projectKind) {
          try {
            const { detectProjectCategory, categoryToServerHint } = await import('../../services/projectTypeDetector')
            const cat = await detectProjectCategory(projectRoot)
            const hint = categoryToServerHint(cat)
            projectKind = hint
          } catch { /* detection failure is non-fatal */ }
        }
        if (!projectKind) projectKind = 'frontend'

        // Frontend-port hint precedence:
        //   1. Explicit `frontend_port_hint` argument from the agent (the
        //      escape hatch when the agent has observed a misclassification).
        //   2. The `.toquemedia-template` manifest's `frontendPort` (scaffolds
        //      ship this for known fullstack templates).
        // Either source feeds the same classifier knob — the agent doesn't
        // need to know which template was used.
        let frontendPortHint = explicitHint
        if (frontendPortHint === undefined) {
          try {
            const { resolveFrontendPortHint } = await import('../../services/templateService')
            frontendPortHint = await resolveFrontendPortHint(projectRoot, projectKind)
          } catch { /* missing manifest is fine — no hint to apply */ }
        }

        try {
          await devServerManager.start(projectRoot, command, { projectKind, frontendPortHint })
          const url = devServerManager.getUrl()
          const hintNote = frontendPortHint ? ` [frontend port hint: ${frontendPortHint}]` : ''
          if (url) {
            return `Dev server started and running at ${url} (${projectKind})${hintNote}. The correct preview panel will open automatically.`
          }
          return `Dev server starting with command: ${command} (${projectKind})${hintNote}. The preview panel will open automatically when the server is ready.`
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error starting dev server: ${msg}. You can try a different command or check that dependencies are installed.`
        }
      }
    })

    // === get_diagnostics ===
    this.tools.set('get_diagnostics', {
      definition: {
        name: 'get_diagnostics',
        description: 'Get TypeScript/JavaScript diagnostics for the developer\'s project. Runs "npx tsc --noEmit" with a 15-second timeout. For faster checks on a single file, prefer running "npx tsc --noEmit path/to/file.ts" via execute_command.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to a TS/JS file or the project root. If a file, checks only that file. If a directory, checks the whole project.' }
          },
          required: ['path']
        },
        // Spawns `npx tsc --noEmit` via execute_command. Read-only — no side effects on
        // the user's project. Safe to run in parallel with other read-only tools.
        concurrencySafe: true,
      },
      execute: async (input) => {
        const filePath = input.path as string
        this.validatePathWithinProject(filePath)

        // Use tsc --noEmit directly instead of the IDE's internal LSP
        // (the LSP is configured for the IDE, not the developer's project)
        const projectRoot = this.getProjectRoot()
        const isFile = filePath.includes('.') && !filePath.endsWith('/')
        const cmd = isFile
          ? `npx tsc --noEmit "${filePath}" 2>&1 || true`
          : `npx tsc --noEmit 2>&1 || true`
        const cwd = isFile ? projectRoot : filePath

        try {
          const result = await invoke<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>('execute_command', {
            command: cmd,
            cwd,
            timeoutSecs: 15,
          })

          if (result.timedOut) {
            return `Diagnostics timed out after 15s. The project may not have TypeScript configured. Try running "npx tsc --noEmit" manually via execute_command with a longer timeout.`
          }

          const output = (result.stdout + '\n' + result.stderr).trim()
          if (!output || result.exitCode === 0) {
            return `No type errors found.`
          }

          // Limit output to prevent context bloat
          const lines = output.split('\n')
          if (lines.length > 30) {
            return lines.slice(0, 30).join('\n') + `\n\n[... ${lines.length - 30} more lines — run tsc manually for full output]`
          }
          return output
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Diagnostics failed: ${msg}. Try running "npx tsc --noEmit" via execute_command as a fallback.`
        }
      }
    })

    // === read_skill ===
    this.tools.set('read_skill', {
      definition: {
        name: 'read_skill',
        description: 'Load the full content of a skill (process, examples, install steps, verification) by its name. The system prompt lists each available skill with a one-line description; call this tool ONCE per skill when you decide it is relevant to the current task. Content stays in conversation history afterward — no need to re-read.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name as listed in the "Skills available" section of the system prompt (e.g., "pdf-document", "frontend-design", "slidev-presentation").' }
          },
          required: ['name']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const name = (input.name as string)?.trim()
        if (!name) return 'Error: read_skill requires a non-empty "name" argument.'
        const skillModule = await import('./skillService')
        const svc = skillModule.default.getInstance()
        const skill = svc.getCachedSkillContent(name)
        if (!skill) {
          const available = svc.getCachedSkillNames()
          return `Error: skill "${name}" is not loaded for the current context. Available skills: ${available.join(', ') || '(none — check the "Skills available" section of the system prompt)'}.`
        }
        // Cache the skill body in module-level state so it survives context
        // compression. After compression strips the original tool result, we
        // re-inject this content so the verbatim CRITICAL blocks aren't lost.
        skillModule.trackInvokedSkill(skill.name, skill.content)
        return svc.formatSkillForReading(skill)
      }
    })

    // === read_large_result ===
    this.tools.set('read_large_result', {
      definition: {
        name: 'read_large_result',
        description: 'Read a portion of a large tool result that was too big to return inline. Use the reference ID from the "Output too large" message. Specify offset and limit to read specific sections.',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Reference ID (e.g., "large_result_1")' },
            offset: { type: 'number', description: 'Character offset to start reading from. Default: 0.' },
            limit: { type: 'number', description: 'Maximum characters to return. Default: 10000. Max: 25000 — read in 2–3 well-targeted pages instead of one giant slice; the suffix tells you exactly how many chars remain.' }
          },
          required: ['id']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const id = input.id as string
        const content = this.largeResults.get(id)
        if (!content) {
          return `Error: Large result "${id}" not found. It may have been cleared from memory. Available results: ${Array.from(this.largeResults.keys()).join(', ') || 'none'}`
        }

        const offset = Math.max(0, (input.offset as number) || 0)
        const limit = Math.min((input.limit as number) || 10000, 25000)
        const slice = content.slice(offset, offset + limit)
        const hasMore = offset + limit < content.length
        const remaining = content.length - offset - limit

        let result = slice
        if (hasMore) {
          result += `\n\n[${remaining} more characters — use offset: ${offset + limit} to continue reading]`
        }
        return result
      }
    })

    // === read_dev_server_logs ===
    this.tools.set('read_dev_server_logs', {
      definition: {
        name: 'read_dev_server_logs',
        description: 'Read output from the dev server AND browser runtime errors from the live preview. Includes: build errors, type errors, HMR failures (from dev server stdout/stderr), plus uncaught exceptions, unhandled promise rejections, console.error, and HTTP 4xx/5xx responses from fetch/XMLHttpRequest in the preview browser (all prefixed [runtime]). Network failures appear as `[runtime] Network: METHOD URL → STATUS STATUSTEXT` — use them to confirm auth-proxy endpoints, /api/* routes, and backend integrations actually return 2xx during testing (a green dev server start does NOT mean the app works end-to-end). Use after file changes, after start_dev_server, or when asked about preview/console/browser/network errors. The buffer is CUMULATIVE — old errors are not cleared when the dev server reloads after a fix. Each entry comes with its timestamp; the response footer includes a cursor (`next_since: <ms>`). Pass that cursor as `since_timestamp` on the next call to get only entries that arrived AFTER your last read — this is how you tell whether your fix actually resolved the previous error vs. seeing the same stale entry. Without `since_timestamp`, you get the tail of the full buffer (default 50 lines).',
        input_schema: {
          type: 'object',
          properties: {
            lines: { type: 'number', description: 'Number of log lines to return when reading the tail. Default: 50. Max: 200. Ignored when since_timestamp is set.' },
            level: { type: 'string', enum: ['all', 'error', 'warn'], description: 'Filter by log level. "error" shows only errors. "warn" shows errors and warnings. "all" shows everything. Default: all.' },
            since_timestamp: { type: 'number', description: 'Unix epoch milliseconds — return only entries with timestamp > this value. Use the next_since cursor from the previous read to get just-arrived entries (the right way to verify a fix landed). Omit on first read.' }
          },
          required: []
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const { useLayoutStore, DEV_LOG_EVENT } = await import('../../stores/layoutStore')

        if (!devServerManager.isActive()) {
          return 'No dev server is running. Start one with start_dev_server.'
        }

        // Event-driven wait for runtime errors. Browser runtime errors
        // (uncaught exceptions, SyntaxError from bad imports) arrive via the
        // preview WebView's IPC → CustomEvent → addDevServerLog pipeline.
        // This pipeline has latency: browser loads → executes JS → throws
        // → dispatches IPC → addDevServerLog fires event.
        //
        // Strategy:
        //   1. Check for RECENT errors (last 5s) — not stale ones from
        //      previous deploys that are already fixed.
        //   2. Only wait if the dev server reloaded recently (last 5s) —
        //      if the server has been stable for a while, no point waiting.
        //   3. Subscribe to DEV_LOG_EVENT and return immediately when an
        //      error arrives. Timeout after 3s.
        //   4. Re-check after subscribing to close the race window between
        //      the initial check and the addEventListener.
        const RECENCY_WINDOW = 5000
        const now = Date.now()

        const hasRecentErrors = () =>
          useLayoutStore.getState().devServerLogs.some(
            l => l.level === 'error' && l.timestamp > now - RECENCY_WINDOW,
          )

        // Only wait if: no recent errors AND server had recent activity
        // (a log was added in the last 5s — proxy for "just reloaded").
        const hasRecentActivity = () => {
          const logs = useLayoutStore.getState().devServerLogs
          return logs.length > 0 && logs[logs.length - 1].timestamp > now - RECENCY_WINDOW
        }

        if (!hasRecentErrors() && hasRecentActivity()) {
          await new Promise<void>(resolve => {
            let timer: ReturnType<typeof setTimeout>
            const handler = (e: Event) => {
              const detail = (e as CustomEvent<{ level: string }>).detail
              if (detail.level === 'error') {
                clearTimeout(timer)
                window.removeEventListener(DEV_LOG_EVENT, handler)
                resolve()
              }
            }
            window.addEventListener(DEV_LOG_EVENT, handler)

            // Re-check: error may have arrived between hasRecentErrors()
            // and addEventListener — close the race window.
            if (hasRecentErrors()) {
              clearTimeout(timer!)
              window.removeEventListener(DEV_LOG_EVENT, handler)
              resolve()
              return
            }

            timer = setTimeout(() => {
              window.removeEventListener(DEV_LOG_EVENT, handler)
              resolve()
            }, 3000)
          })
        }

        const logs = useLayoutStore.getState().devServerLogs

        if (logs.length === 0) {
          return 'Dev server is running but has produced no output yet.'
        }

        // The buffer is cumulative — old errors persist after fixes.
        // since_timestamp lets the agent fetch only entries that arrived
        // after its last read, which is the only reliable way to tell
        // whether a fix actually resolved the previous error.
        const sinceTimestamp = (input.since_timestamp as number) || 0
        const maxLines = Math.min((input.lines as number) || 50, 200)
        const levelFilter = (input.level as string) || 'all'

        let filtered = logs
        if (sinceTimestamp > 0) {
          filtered = filtered.filter(l => l.timestamp > sinceTimestamp)
        }
        if (levelFilter === 'error') {
          filtered = filtered.filter(l => l.level === 'error')
        } else if (levelFilter === 'warn') {
          filtered = filtered.filter(l => l.level === 'warn' || l.level === 'error')
        }

        // Tail-slice only when no cursor was provided. With since_timestamp
        // the agent wants the full delta, not the tail of it.
        const recent = sinceTimestamp > 0 ? filtered : filtered.slice(-maxLines)

        // Cursor for the next call — always the last entry's timestamp in
        // the FULL (unfiltered) buffer, not the filtered slice. Otherwise
        // a level=error read would skip past info entries and the next
        // since_timestamp call would re-surface them as "new".
        const nextSince = logs[logs.length - 1].timestamp

        if (recent.length === 0) {
          const sinceLabel = sinceTimestamp > 0 ? ' since last read' : ''
          return `No ${levelFilter === 'all' ? 'new ' : levelFilter + '-level '}logs${sinceLabel}. Dev server appears healthy.\nnext_since: ${nextSince}`
        }

        const formatted = recent.map(l => {
          const prefix = l.level === 'error' ? 'ERROR' : l.level === 'warn' ? 'WARN' : 'INFO'
          return `[${prefix}] [${l.timestamp}] ${l.text}`
        }).join('\n')

        const errorCount = recent.filter(l => l.level === 'error').length
        const warnCount = recent.filter(l => l.level === 'warn').length
        const header = sinceTimestamp > 0
          ? `Dev server logs since ${sinceTimestamp} (${recent.length} new entries, ${errorCount} errors, ${warnCount} warnings):`
          : `Dev server logs (${recent.length} lines, ${errorCount} errors, ${warnCount} warnings):`

        return `${header}\n${formatted}\nnext_since: ${nextSince}`
      }
    })

    // === research (sub-agent) ===
    this.tools.set('research', {
      definition: {
        name: 'research',
        description: 'Delegate a task to a parallel sub-agent that can read, create, edit, search files, AND search the internet. Use to investigate code, refactor in parallel, research technical topics online, or handle independent sub-tasks. Multiple research calls run concurrently. The sub-agent returns a text summary of what it did.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The task or question for the sub-agent' },
            context: { type: 'string', description: 'Optional context to help the sub-agent (e.g., relevant file paths, what you already know)' }
          },
          required: ['question']
        }
      },
      execute: async (input) => {
        const question = input.question as string
        const context = (input.context as string) || ''

        // Lazy import to avoid circular dependency
        const { default: AgentService } = await import('./agentService')

        // Sub-agent tools: read, write, create, edit, search, glob, diagnostics + web research
        const subAgentToolNames = new Set([
          'read_file', 'write_file', 'create_file', 'edit_file',
          'list_directory', 'search_files', 'glob', 'get_diagnostics',
          'web_search',   // native on DashScope models, side-car to Qwen on GLM-5.1
          'web_fetch',    // frontend fetches a specific URL
        ])
        const subAgentTools = this.getToolDefinitions().filter(t =>
          subAgentToolNames.has(t.function.name)
        )

        // Phase B: derive the sub-agent's abort from the per-call signal.
        const subAbort = createLinkedAbortController(input._abortSignal as AbortSignal | undefined)
        const subAgent = AgentService.createLightweight({
          tools: subAgentTools,
          readOnly: false,
          abortController: subAbort,
        })

        const projectRoot = this.getProjectRoot()
        const systemPrompt = `You are a sub-agent inside TM Code. Complete the task using the available tools. You can read, create, edit, and search files, AND search the internet for information.

Available tools:
- File operations: read_file, write_file, create_file, edit_file
- Search: search_files (ripgrep), glob, list_directory
- Web research:
  - web_search — takes a natural-language query and returns ranked results with titles, snippets, and URLs. This is how you discover what pages exist on a topic.
  - web_fetch — takes one complete target URL you already know and returns the contents of that single page. This is how you read the body of a specific article, doc, or API reference.
  - Typical flow: start with web_search to find relevant URLs, then web_fetch on the most promising result to read its full content.
- Diagnostics: get_diagnostics

Be thorough but concise.

Project root: ${projectRoot}`

        subAgent.setSystemPrompt(systemPrompt)

        const prompt = context
          ? `${question}\n\nContext: ${context}`
          : question

        let result = ''
        let totalTokens = 0
        let toolsCalled = 0
        const toolCallId = input._toolCallId as string | undefined

        const updateProgress = (status: string) => {
          if (toolCallId) {
            const tokenStr = totalTokens > 0 ? ` | ${Math.round(totalTokens / 1000)}K tokens` : ''
            useChatStore.getState().updateToolCallProgress(toolCallId, `${status}${tokenStr}`)
          }
        }

        updateProgress('Starting research...')

        // Forward every sub-agent event to the main chatStore so the user sees
        // the FULL activity in real-time. Visibility logic extracted to a pure
        // helper — see src/services/agent/subAgentVisibility.ts.
        const chatStore = useChatStore.getState()
        const { useAgentStore } = await import('../../stores/agentStore')
        const agentStore = useAgentStore.getState()
        const { createSubAgentVisibility } = await import('./subAgentVisibility')

        const visibility = createSubAgentVisibility({
          parentToolCallId: toolCallId,
          reasoningLabel: 'research sub-agent',
          hooks: {
            appendTextDelta: chatStore.appendTextDelta,
            appendReasoningDelta: chatStore.appendReasoningDelta,
            addPendingToolCall: chatStore.addPendingToolCall,
            updateToolCallWithArgs: chatStore.updateToolCallWithArgs,
            updateToolCallWithResult: chatStore.updateToolCallWithResult,
            setStatus: (s) => agentStore.setStatus(s),
          },
        })

        await subAgent.runAgentLoop(prompt, [], {
          onTextDelta: (delta) => {
            result += delta
            visibility.callbacks.onTextDelta(delta)
          },
          onReasoningDelta: (delta) => {
            visibility.callbacks.onReasoningDelta(delta)
            updateProgress('Thinking...')
          },
          onToolCallPending: (childId, toolName) => {
            toolsCalled++
            visibility.callbacks.onToolCallPending(childId, toolName)
            updateProgress(`Using ${toolName}...`)
          },
          onToolCallStart: (childId, toolName, args) => {
            visibility.callbacks.onToolCallStart(childId, toolName, args)
            const target = (args.path as string)?.replace(/\\/g, '/').split('/').pop()
              || (args.query as string)
              || (args.pattern as string)
              || (args.url as string)
              || ''
            updateProgress(`${toolName}: ${target}`)
          },
          onToolResult: (childId, toolName, res, isError) => {
            visibility.callbacks.onToolResult(childId, toolName, res, isError)
          },
          onTurnComplete: () => {},
          onDone: (finalText) => {
            if (finalText && !result) result = finalText
            updateProgress(`Done — ${toolsCalled} tool calls`)
          },
          onError: (error) => {
            result = `Research error: ${error.message}`
            visibility.cleanupOrphans(`aborted: research sub-agent failed — ${error.message}`)
            updateProgress('Error')
          },
          onUsageUpdate: (inputTokens, outputTokens) => {
            totalTokens += inputTokens + outputTokens
          },
        } satisfies AgentCallbacks)

        return result || 'No results found.'
      }
    })

    // === spawn_background_agent ===
    this.tools.set('spawn_background_agent', {
      definition: {
        name: 'spawn_background_agent',
        description: 'Start a background sub-agent that works independently while you continue. The sub-agent can read, search, and analyze files but CANNOT write or execute commands. Use for research tasks that do not need immediate results. Returns a tracking ID — use check_background_agents to retrieve results later.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The task or question for the background agent' },
            context: { type: 'string', description: 'Optional context (file paths, prior knowledge)' },
          },
          required: ['question']
        }
      },
      execute: async (input) => {
        const question = input.question as string
        const context = (input.context as string) || ''

        const { useBackgroundAgentStore } = await import('../../stores/backgroundAgentStore')
        const bgStore = useBackgroundAgentStore.getState()

        if (bgStore.getRunningCount() >= 4) {
          return 'Cannot start: maximum 4 background agents running. Wait for one to complete or use check_background_agents.'
        }

        const { default: AgentService } = await import('./agentService')

        // Read-only tool subset
        const bgToolNames = new Set([
          'read_file', 'list_directory', 'search_files', 'glob',
          'get_diagnostics', 'web_fetch',
        ])
        const bgTools = this.getToolDefinitions().filter(t =>
          bgToolNames.has(t.function.name)
        )

        // Phase B: derive bg agent abort from the per-call signal.
        const bgAbort = createLinkedAbortController(input._abortSignal as AbortSignal | undefined)

        const subAgent = AgentService.createLightweight({
          tools: bgTools,
          readOnly: true,
          maxTurns: 30,
          abortController: bgAbort,
        })

        const projectRoot = this.getProjectRoot()
        subAgent.setSystemPrompt(
          `You are a background research agent inside TM Code. Investigate the task using read-only tools. Be thorough and produce a clear summary.\n\nProject root: ${projectRoot}`
        )

        const agentId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const prompt = context ? `${question}\n\nContext: ${context}` : question

        bgStore.addAgent({
          id: agentId,
          question,
          status: 'running',
          result: null,
          toolsCalled: 0,
          totalTokens: 0,
          progressText: 'Starting...',
          startedAt: Date.now(),
          completedAt: null,
          abortController: bgAbort,
        })

        // Fire and forget — do NOT await
        let resultText = ''
        let tokens = 0
        let calls = 0

        // Forward events to the main chatStore AND the bg store. The key
        // difference from research/verify: we capture the active `streamingMessageId`
        // at spawn time and pass it as `targetMessageId` to every chat-store write.
        // This keeps the sub-agent's tool calls flowing into the SAME assistant
        // message even after the main turn finalizes (at which point
        // `streamingMessageId` becomes null). Without this, bg-agent activity
        // past the main turn end would be invisible in the chat feed.
        const parentToolCallId = input._toolCallId as string | undefined
        const chatStore = useChatStore.getState()
        const targetMessageId = chatStore.streamingMessageId ?? undefined
        const { useAgentStore } = await import('../../stores/agentStore')
        const agentStore = useAgentStore.getState()
        const { createSubAgentVisibility } = await import('./subAgentVisibility')

        const visibility = createSubAgentVisibility({
          parentToolCallId,
          reasoningLabel: 'background sub-agent',
          targetMessageId,
          hooks: {
            appendTextDelta: chatStore.appendTextDelta,
            appendReasoningDelta: chatStore.appendReasoningDelta,
            addPendingToolCall: chatStore.addPendingToolCall,
            updateToolCallWithArgs: chatStore.updateToolCallWithArgs,
            updateToolCallWithResult: chatStore.updateToolCallWithResult,
            setStatus: (s) => agentStore.setStatus(s),
          },
        })

        subAgent.runAgentLoop(prompt, [], {
          onTextDelta: (delta) => {
            resultText += delta
            visibility.callbacks.onTextDelta(delta)
          },
          onReasoningDelta: (delta) => {
            visibility.callbacks.onReasoningDelta(delta)
            bgStore.updateProgress(agentId, 'Thinking...', calls, tokens)
          },
          onToolCallPending: (childId, toolName) => {
            calls++
            visibility.callbacks.onToolCallPending(childId, toolName)
            bgStore.updateProgress(agentId, `Using ${toolName}...`, calls, tokens)
          },
          onToolCallStart: (childId, toolName, args) => {
            visibility.callbacks.onToolCallStart(childId, toolName, args)
            const target = (args.path as string)?.replace(/\\/g, '/').split('/').pop()
              || (args.query as string)
              || (args.pattern as string)
              || ''
            bgStore.updateProgress(agentId, `${toolName}: ${target}`, calls, tokens)
          },
          onToolResult: (childId, toolName, res, isError) => {
            visibility.callbacks.onToolResult(childId, toolName, res, isError)
          },
          onTurnComplete: () => {},
          onDone: (finalText) => {
            if (finalText && !resultText) resultText = finalText
            useBackgroundAgentStore.getState().completeAgent(agentId, resultText || 'No results found.')
          },
          onError: (error) => {
            visibility.cleanupOrphans(`aborted: background sub-agent failed — ${error.message}`)
            useBackgroundAgentStore.getState().failAgent(agentId, error.message)
          },
          onUsageUpdate: (inp, out) => {
            tokens += inp + out
          },
        } satisfies AgentCallbacks).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          visibility.cleanupOrphans(`aborted: background sub-agent crashed — ${msg}`)
          useBackgroundAgentStore.getState().failAgent(agentId, msg)
        })

        return `Background agent "${agentId}" started for: "${question}". Use check_background_agents to see results when ready.`
      }
    })

    // request_thinking tool REMOVED — reasoning is always ON when the
    // active model supports it (claude-vaz parity). The agent does not
    // request thinking on demand; profile.supportsThinking is the single
    // switch and it's evaluated in agentService.buildRequestBody.

    // === update_tasks ===
    this.tools.set('update_tasks', {
      definition: {
        name: 'update_tasks',
        description: 'Create or update a task list visible to the developer in the chat UI. Use at the start of complex work to show what you plan to do, and update task statuses as you complete each step. The developer sees checkboxes with real-time progress.',
        input_schema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Unique task ID (e.g., "1", "install_deps")' },
                  description: { type: 'string', description: 'Short task description' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status' },
                },
                required: ['id', 'description', 'status'],
              },
              description: 'Full task list. Each call replaces the previous list — always send the complete state.',
            },
          },
          required: ['tasks'],
        },
      },
      execute: async (input) => {
        const { useAgentStore } = await import('../../stores/agentStore')
        // Defensive: streaming JSON parse can deliver a truthy non-array (e.g.
        // partial object) before the call settles. Coerce to array.
        const raw = input.tasks
        const tasks = Array.isArray(raw)
          ? (raw as Array<{ id: string; description: string; status: 'pending' | 'in_progress' | 'completed' }>)
          : []
        useAgentStore.getState().setTasks(tasks)
        // Plan-mode progress: a successful update_tasks after PLAN.md is the
        // signal that the architect has finished. Combined with planFileWritten
        // this trips the strict-STOP guard in execute() on any subsequent call.
        if (this.planMode && this.planFileWritten) {
          this.planTasksSeeded = true
        }
        const completed = tasks.filter(t => t.status === 'completed').length
        return `Task list updated: ${completed}/${tasks.length} completed.`
      }
    })

    // === check_background_agents ===
    this.tools.set('check_background_agents', {
      definition: {
        name: 'check_background_agents',
        description: 'Check the status and results of background agents. Returns all running and recently completed agents with their results.',
        input_schema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      execute: async () => {
        const { useBackgroundAgentStore } = await import('../../stores/backgroundAgentStore')
        const agents = useBackgroundAgentStore.getState().getAll()

        if (agents.length === 0) {
          return 'No background agents have been started.'
        }

        const lines: string[] = []
        for (const agent of agents) {
          const elapsed = agent.completedAt
            ? `${Math.round((agent.completedAt - agent.startedAt) / 1000)}s`
            : `${Math.round((Date.now() - agent.startedAt) / 1000)}s elapsed`

          if (agent.status === 'running') {
            lines.push(`[RUNNING] ${agent.id}: "${agent.question}" (${elapsed}, ${agent.toolsCalled} tools, ${agent.progressText})`)
          } else if (agent.status === 'completed') {
            lines.push(`[DONE] ${agent.id}: "${agent.question}" (${elapsed}, ${agent.toolsCalled} tools)\nResult:\n${agent.result}`)
          } else if (agent.status === 'error') {
            lines.push(`[ERROR] ${agent.id}: "${agent.question}" — ${agent.result}`)
          } else if (agent.status === 'cancelled') {
            lines.push(`[CANCELLED] ${agent.id}: "${agent.question}"`)
          }
        }

        return lines.join('\n\n')
      }
    })

    // === verify (adversarial verification sub-agent) ===
    // === provision_auth ===
    // One-shot tool that provisions authentication for the current project:
    // 1. Calls the backend's /v1/auth/provision-gip to get-or-create the
    //    per-project auth tenant on the shared platform project. Idempotent.
    // 2. Writes the returned credentials to .env via write_env_vars: the
    //    neutral TM_* names (preferred for new code) PLUS the legacy
    //    FIREBASE_* / GIP_* / GCP_PROJECT_ID names (backward compat with
    //    already-scaffolded projects whose code still references them).
    // 3. Returns a structured summary with the auth contract (env keys, env
    //    loading rules, auth-API call shape, frontend wiring, DB caveats,
    //    smoke test) — read by the agent before it scaffolds the auth-proxy.
    //
    // The agent uses this when the user requests login/signup/auth in their
    // project. After this tool returns, the agent should:
    //   - read_skill('auth-proxy') for the frontend recipe
    //   - read_skill('google-signin') if Google sign-in is requested
    //   - mount the auth-proxy router in the backend entry (app.use('/api', authProxyRouter))
    //
    // This tool does NOT write code or copy boilerplate. The agent chooses the
    // backend stack (Express / Hono / Fastify / Nest / FastAPI / Go / etc.) and
    // implements routes following the skill — see authCommand.ts.
    this.tools.set('provision_auth', {
      definition: {
        name: 'provision_auth',
        description:
          'Set up TM Code Authentication for the current project. Reserves a per-project auth tenant on the platform and writes the necessary credentials to .env. Use ONCE per project when the user requests login/signup/auth. The agent then implements the auth-proxy and frontend in whatever stack fits the project (Express, Hono, Fastify, FastAPI, etc.) — see read_skill("auth-proxy") for the protocol. After this returns, the project has every credential it needs: the auth-proxy uses the public client key written to .env for identity provider calls. Skip request_credentials for any platform-managed credential (admin SDK keys, service-account files, infrastructure tokens) — they live only on the TM Code worker and the user does not have them.',
        input_schema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              enum: ['gip'],
              description: 'Auth provider. Currently only "gip" is supported.',
            },
          },
          required: ['provider'],
        },
      },
      execute: async (input) => {
        const provider = String(input.provider || '').toLowerCase()
        if (provider !== 'gip') {
          return `Unsupported auth provider: ${provider}. Only "gip" is supported.`
        }

        const project = useProjectStore.getState().currentProject
        if (!project) {
          return 'No project is open. Open a project before provisioning auth.'
        }

        // Early-return guard: if auth is already provisioned (detected from
        // .env + filesystem markers), don't re-run the network call. The
        // backend is idempotent (get-or-create) so re-running is safe — but
        // returning early with an instructive message avoids wasted tokens
        // AND signals to the agent "fix existing" instead of "re-scaffold".
        // Defense-in-depth alongside the system-prompt section and the UI
        // hint that warn before the tool is even invoked.
        try {
          const { detectScaffolding } = await import('../scaffoldingDetector')
          const detected = await detectScaffolding(project.path)
          const hasEmailAuth = detected.applied.includes('auth.email-password')
          const hasGoogleAuth = detected.applied.includes('auth.google')
          if (hasEmailAuth || hasGoogleAuth) {
            const evidence: string[] = []
            if (hasEmailAuth) evidence.push(...(detected.evidence['auth.email-password'] ?? []))
            if (hasGoogleAuth) evidence.push(...(detected.evidence['auth.google'] ?? []))
            // Telemetry for the agent-initiated re-provision path. The
            // smart-router (chat-mode + cmd-mode) covers user-initiated
            // hashtag re-runs; this captures the case where the model
            // reaches for provision_auth on its own despite the system-
            // prompt section. High frequency = system prompt isn't being
            // attended to; consider strengthening the bookend.
            import('../../services/analytics').then(({ trackEvent }) => {
              void trackEvent('provision_auth_early_return', {
                applied: [hasEmailAuth ? 'auth.email-password' : '', hasGoogleAuth ? 'auth.google' : ''].filter(Boolean).join(','),
              })
            }).catch(() => { /* non-critical */ })
            return `Already provisioned. Detected: ${evidence.join(', ')}.\n\nDO NOT re-run provision_auth on the default path — the .env credentials already exist and the backend is idempotent (returns the same tenant). The default task is to FIX the existing implementation:\n  1. read_file the marker paths above to see what's there.\n  2. Diagnose the actual bug (read_dev_server_logs for runtime errors, get_diagnostics for type errors).\n  3. Edit the broken file with edit_file.\n\nEXCEPTION — explicit re-provisioning. If the developer's CURRENT message includes any of: "re-provision", "rotate credentials", "wipe and start over", "reset the auth", "delete and re-create the tenant", "reprovisiona", "rotaciona credenciais", "apaga e recomeça" — they have OPTED IN. In that case, ack in chat what you'll do, then call provision_auth again (the same call you just received). The platform is idempotent so the tenant won't duplicate; .env is overwritten with the same values; no destructive change to data. If the developer's intent is unclear, ASK before re-running.`
          }
        } catch { /* non-critical — fall through to normal provisioning */ }

        const firebaseAuth = FirebaseAuthService.getInstance()
        const idToken = await firebaseAuth.getIdToken()
        if (!idToken) {
          return 'Not authenticated to TM Code. Sign in first, then retry.'
        }

        const workerUrl = resolveWorkerUrl()
        let provisionRes: Awaited<ReturnType<typeof tauriFetch>>
        try {
          provisionRes = await tauriFetch(`${workerUrl}/v1/auth/provision-gip`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              projectId: project.id,
              projectName: project.name,
            }),
          })
        } catch (err) {
          // Same hard-stop contract as the HTTP-error path below. Network
          // failures used to read as transient by the model and trigger
          // "let me ask the developer for the credentials instead", which
          // is always wrong (the credentials don't exist until provision_auth
          // succeeds).
          return (
            `PROVISION_AUTH FAILED — STOP THE AUTH IMPLEMENTATION NOW.\n\n` +
            `Network error reaching the auth provisioning endpoint: ${err instanceof Error ? err.message : String(err)}\n\n` +
            `Do NOT fall back to request_credentials for VITE_FIREBASE_*, VITE_TM_*, VITE_GOOGLE_CLIENT_ID. ` +
            `Those credentials do not exist until provision_auth succeeds; asking the developer to type them is impossible to satisfy.\n\n` +
            `Required recovery: report the network error to the developer in chat, suggest checking their connection, and wait for them to decide whether to retry. Do not auto-retry.`
          )
        }

        if (!provisionRes.ok) {
          const body = await provisionRes.text().catch(() => '')
          // STOP signal — without this, the model rationalises around the
          // failure and falls back to request_credentials for VITE_FIREBASE_*
          // and friends, which only ever produces a form the developer
          // cannot satisfy. Hard-block the rationalisation by naming the
          // exact wrong-next-steps and prescribing the correct recovery.
          return (
            `PROVISION_AUTH FAILED — STOP THE AUTH IMPLEMENTATION NOW.\n\n` +
            `Error from worker (HTTP ${provisionRes.status}): ${body.slice(0, 300)}\n\n` +
            `What this means: the platform tenant for this project could not be created. ` +
            `Without it, NONE of the auth credentials exist — there is no Firebase API key, no auth domain, ` +
            `no tenant id, no Google client id. Auth simply cannot be implemented until provision_auth succeeds.\n\n` +
            `Wrong recovery paths (DO NOT TAKE):\n` +
            `  ✗ request_credentials for VITE_FIREBASE_*, VITE_TM_*, VITE_GOOGLE_CLIENT_ID — the developer does not have these; the form will block on the platform-managed field IDs anyway.\n` +
            `  ✗ "implement auth-proxy manually" — the proxy still needs the platform tenant; without it every call returns API_KEY_INVALID.\n` +
            `  ✗ scaffold a LoginScreen / Firebase init expecting VITE_FIREBASE_API_KEY to exist later.\n\n` +
            `Required recovery:\n` +
            `  1. STOP the auth task. Do not write any auth-related code.\n` +
            `  2. Tell the developer in chat what happened — quote the error above verbatim.\n` +
            `  3. Suggest one of: (a) retry provision_auth in a new chat turn if this is a transient error, (b) report the error to TM Code support if it persists, (c) skip the auth feature for now.\n` +
            `  4. Wait for the developer's decision. Do not auto-retry.`
          )
        }

        const data = (await provisionRes.json()) as {
          tenantId?: string
          apiKey?: string
          authDomain?: string
          projectId?: string
          googleClientId?: string | null
        }

        if (!data.tenantId || !data.apiKey || !data.authDomain || !data.projectId) {
          return `Provisioning returned incomplete data: ${JSON.stringify(data)}`
        }

        // Write the credentials to .env via the same single-write-path used by
        // request_credentials. Dual-write the new TM-prefixed names + the
        // legacy Firebase/GIP/GCP names so existing user projects (which
        // reference the legacy names in their code) continue to work, while
        // new code generated by the agent uses the neutral names. Both sets
        // hold the same values; the duplication is the migration cost paid
        // once per project. The legacy names will be removed in a future
        // release after enough projects have migrated.
        const envVars: Array<{ key: string; value: string }> = [
          // Neutral names (preferred for new code)
          { key: 'VITE_TM_AUTH_KEY', value: data.apiKey },
          { key: 'VITE_TM_AUTH_DOMAIN', value: data.authDomain },
          { key: 'VITE_TM_PROJECT_ID', value: data.projectId },
          { key: 'VITE_TM_TENANT_ID', value: data.tenantId },
          { key: 'TM_AUTH_KEY', value: data.apiKey },
          { key: 'TM_TENANT_ID', value: data.tenantId },
          { key: 'TM_PROJECT_ID', value: data.projectId },
          // Legacy names (kept for backward compatibility with already-scaffolded
          // projects). New agent-generated code reads the TM_* names above;
          // these continue to be written so a re-provision on an old project
          // doesn't break existing references.
          { key: 'VITE_FIREBASE_API_KEY', value: data.apiKey },
          { key: 'VITE_FIREBASE_AUTH_DOMAIN', value: data.authDomain },
          { key: 'VITE_FIREBASE_PROJECT_ID', value: data.projectId },
          { key: 'VITE_GIP_TENANT_ID', value: data.tenantId },
          { key: 'GCP_PROJECT_ID', value: data.projectId },
          { key: 'GIP_TENANT_ID', value: data.tenantId },
          { key: 'GIP_FIREBASE_API_KEY', value: data.apiKey },
        ]
        if (data.googleClientId) {
          envVars.push({ key: 'VITE_TM_GOOGLE_CLIENT_ID', value: data.googleClientId })
          envVars.push({ key: 'VITE_GOOGLE_CLIENT_ID', value: data.googleClientId }) // legacy
        }

        try {
          await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
        } catch (err) {
          return `Wrote tenant ${data.tenantId} but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
        }

        // .env just changed — invalidate detection cache so the next
        // detectScaffolding call picks up the new credentials immediately.
        try {
          const { invalidateScaffoldingCache } = await import('../scaffoldingDetector')
          invalidateScaffoldingCache(project.path)
        } catch { /* non-critical */ }

        // Structured contract: machine-readable header + skill-readable
        // body. The header lists the env vars and the rules the agent must
        // honour when implementing the proxy. Empirically (BugHunterKimi
        // session, May 2026) the prose-only response let the agent forget
        // canonical rules — `tenantId` was dropped from `signInWithIdp`,
        // backend env was read from `VITE_*` instead of `GIP_*` mirrors,
        // dotenv.config() was used manually instead of `--env-file`.
        // The structured block makes each rule one bullet per scan line.
        const lines: string[] = []
        // Tenant id is internal-ish (matters for diagnosing auth bugs) but
        // the platform GCP project id is not relevant to the chat agent —
        // it would leak the platform project name when the developer asks
        // the agent to summarise what happened or generate manual-deploy
        // scripts. Keep the tenant id (already in .env via VITE_GIP_TENANT_ID),
        // drop the project id.
        lines.push(`Authentication tenant ready: ${data.tenantId}.`)
        lines.push(`.env written: ${envVars.map((v) => v.key).join(', ')}.`)
        lines.push('')
        lines.push('## Auth contract (do not improvise — these rules are not negotiable)')
        lines.push('')
        lines.push('### Env keys (already in .env — read them, do not regenerate)')
        lines.push('  - Frontend (Vite, public): VITE_TM_AUTH_KEY, VITE_TM_AUTH_DOMAIN, VITE_TM_PROJECT_ID, VITE_TM_TENANT_ID' + (data.googleClientId ? ', VITE_TM_GOOGLE_CLIENT_ID' : ''))
        lines.push('  - Backend (server-only): TM_AUTH_KEY, TM_TENANT_ID, TM_PROJECT_ID')
        lines.push('  - The backend reads the server-only names (TM_* without VITE_ prefix), the frontend reads the VITE_TM_* mirrors. Both hold the same values; the split avoids the bug where the agent reads a frontend key on the server before dotenv loads.')
        lines.push('  - Legacy names (VITE_FIREBASE_*, GIP_*, GCP_PROJECT_ID, VITE_GOOGLE_CLIENT_ID) are also written for backward compat with existing code. New code reads the TM_* names — explain to the developer as "your project credentials" in chat prose, not by listing variable names.')
        lines.push('')
        lines.push('### Env loading (eliminates the dotenv-config-after-imports class of bug)')
        lines.push('  - Node 20.6+: pass --env-file=.env in the dev script (e.g. `tsx watch --env-file=../.env src/index.ts`).')
        lines.push('  - Bun: loads .env automatically.')
        lines.push('  - NestJS: ConfigModule.forRoot({ isGlobal: true }).')
        lines.push('  - Older Node fallback only: `import \'dotenv/config\'` at the very top of the entry file. Never `dotenv.config({ path: ... })` after other imports — ESM hoists imports above the call.')
        lines.push('')
        lines.push('### Auth-API calls')
        lines.push('  - Every signInWithIdp / signInWithPassword / signUp request body includes `tenantId` (read from `TM_TENANT_ID`). Without it, the auth API returns 400 with INVALID_ID_TOKEN or a tenant-mismatch error.')
        lines.push('  - Map auth-API 4xx responses to 401 (auth failure), not 502. 502 is for upstream 5xx / network errors only.')
        lines.push('')
        lines.push('### Frontend wiring')
        lines.push('  - Vite proxy MUST forward /api to the backend port — `server.proxy[\'/api\']` in vite.config.ts. Without it, every fetch(\'/api/...\') hits port 5173 and returns 404 HTML. CORS headers are NOT a substitute.')
        lines.push('  - In a monorepo (vite.config.ts in client/ while .env is at root), set `envDir: path.resolve(__dirname, \'..\')`. In a flat layout, do NOT set envDir — over-set silently breaks all VITE_* reads.')
        lines.push('  - firebase.ts: `auth.tenantId = import.meta.env.VITE_TM_TENANT_ID`. Inside an iframe (IDE preview), call `setPersistence(auth, inMemoryPersistence)`.')
        lines.push('  - Only `onAuthStateChanged` is importable from firebase/auth. NEVER signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, etc. — popup is silently blocked in the IDE preview webview.')
        lines.push('')
        lines.push('### Data layer — publish-ready by DEFAULT (TM Code Database)')
        lines.push('  - Use `drizzle-orm` + `@libsql/client` for persistence. The harness rejects incompatible-shape deps (`@prisma/client`, `prisma`, `better-sqlite3`, `sqlite3`, `mysql2`, `pg`) on writes to package.json — Prisma needs a persistent connection (incompatible with Cloud Run scale-to-zero + worker HTTPS proxy); native-bound SQLite drivers and non-SQLite dialects don\'t round-trip through the worker.')
        lines.push('  - Generate `server/db.ts` with the dev/prod connection switch: `drizzle-orm/libsql/node` against `DATABASE_URL=file:./dev.db` in dev, `drizzle-orm/sqlite-proxy` against `TMDB_URL` + `TMDB_TOKEN` in prod. The libSQL endpoint and Turso credentials stay in the TM Code Worker — never in user code or `.env`.')
        lines.push('  - Schema in TypeScript via `server/schema.ts`. Generate migrations with `drizzle-kit generate`; the deploy pipeline reapplies them against the app\'s TMDB at publish time.')
        lines.push('  - Full SQL ergonomics — `where + orderBy` on different fields, multi-where, JOINs, aggregations, transactions. No composite-index trap. Performance indexes via `index().on(...)` in Drizzle schema.')
        lines.push('')
        lines.push('### Dockerfile — generated in the SAME scaffold turn')
        lines.push('  - When the project has a backend (server/ or backend/ directory, or backend deps), generate a `Dockerfile` + `.dockerignore` at the project root in the same turn that creates the backend code. The Publish detector classifies a project as composite only when `Dockerfile` is present; without it, Publish ships the frontend and the backend stays unpublished — silent failure mode.')
        lines.push('  - Templates by language in `read_skill("publish-backend")` §8. Node 22 is the default; Python (FastAPI/Flask) is the other shipped option.')
        lines.push('  - Skip `cloudbuild.yaml` — the platform build pipeline runs an inline spec server-side; a file at the project root is unused.')
        lines.push('')
        lines.push('### Existing-project rule')
        lines.push('  - When you find legacy `firebase-admin/firestore` or Prisma in the project, port it to Drizzle + libSQL first, before adding auth code. A hybrid persistence layer breaks Publish.')
        lines.push('  - `firebase-admin/auth` stays — it\'s used for GIP JWT verification, separate from the data layer. Only the `/firestore` and `/database` imports are removed.')
        lines.push('  - For the auth-proxy boilerplate, `read_skill("auth-proxy")` covers Express, Fastify, NestJS, Hono, FastAPI.')
        lines.push('')
        lines.push('### After the phase that adds /api/auth/* — REQUIRED smoke test')
        lines.push('  - `execute_command: curl -s -o /dev/null -w \'%{http_code} %{content_type}\\n\' http://localhost:5173/api/auth/me` MUST return `401 application/json`. If 404 HTML, the Vite proxy is missing — fix before claiming the phase done.')
        lines.push('')
        lines.push('## Next-step references')
        lines.push('  1. read_skill("auth-proxy") for the full protocol.')
        lines.push('  2. read_skill("google-signin") if Google sign-in is requested.')
        lines.push('  3. CREDENTIALS COMPLETE — request_credentials is for third-party integrations the developer adds (OpenAI, Stripe, etc.), not for anything the platform manages. The public client key in .env is the only auth credential the project needs; admin keys and service-account files live only on the platform side.')

        return lines.join('\n')
      },
    })

    // === provision_deploy ===
    // Mirrors provision_auth for the backend deploy side. With the Firestore
    // data model there's no per-app database to provision — the app's data
    // lives at apps/{APP_ID}/... under the shared (default) Firestore in
    // dev-studio-projects, isolated by Security Rules. The tool:
    // 1. Calls /v1/projects/deploy/init to reserve <slug>.toquemedia.net +
    //    create the projectDeployments record (subscription/quota gated).
    // 2. Writes APP_ID (= project.id) to .env so the server code can build
    //    its paths under apps/${APP_ID}/...
    // 3. Returns a summary the agent reads before swapping the DB layer to
    //    the Firebase Admin SDK (read_skill('publish-backend')
    //    for the cost-conscious access patterns).
    //
    // Reserved for the Publish flow. The agent should NOT call this during
    // normal scaffolding — the system prompt's Publishing section explains
    // the rationale (paid commitment, hostname reservation, quota slot).
    // Idempotent: if APP_ID is already in .env, returns no-op.
    this.tools.set('provision_deploy', {
      definition: {
        name: 'provision_deploy',
        description:
          "Reserve a public hostname for this project and register it in the platform's publish quota. Writes APP_ID to .env (the per-app data namespace). RESERVED for the Publish flow — do NOT call this from scaffolding turns. The publish-ready code shape (firebase-admin data layer, Dockerfile, cache pattern) must be in place BEFORE this is called; use APP_ID with a local-dev fallback in your db.ts so the backend runs without this tool ever firing. Idempotent: a second call when APP_ID already exists returns a no-op. May return DEPLOY_QUOTA (free=0/vibe=1/pro=2/max=5 active publishes) — surface verbatim and stop.",
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      execute: async () => {
        const project = useProjectStore.getState().currentProject
        if (!project) {
          return 'No project is open. Open a project before provisioning the deploy.'
        }

        // Defense-in-depth: the system prompt instructs the agent to NOT
        // call provision_deploy during normal scaffolding turns — the
        // Publish flow owns this. The agent may still call it (e.g., if a
        // legacy prompt or a user instruction asks for it). Make it
        // idempotent so a stray call from scaffolding doesn't double-
        // reserve, double-consume quota, or trigger surprise public-host
        // commitments. If APP_ID is already in .env, treat as no-op.
        try {
          const existing = await invoke<string>('read_file', {
            path: `${project.path}/.env`,
          })
          if (typeof existing === 'string' && /^\s*APP_ID\s*=/m.test(existing)) {
            return (
              `provision_deploy already applied to "${project.name}" — APP_ID is in .env. ` +
              `Skipping re-provision. If you intended to rotate the slug or move to a different ` +
              `plan, the developer must do that from Settings → Deploys (not from the agent).`
            )
          }
        } catch {
          // .env doesn't exist yet — fine, continue with the normal flow.
        }

        const firebaseAuth = FirebaseAuthService.getInstance()
        const idToken = await firebaseAuth.getIdToken()
        if (!idToken) {
          return 'Not authenticated to TM Code. Sign in first, then retry.'
        }
        const workerUrl = resolveDeployUrl()

        // /init reserves the slug + creates the projectDeployments record
        // (quota gated, idempotent on re-run). No DB provisioning — the
        // platform database is a shared default with per-app path scoping;
        // nothing to physically create up front.
        let initRes: Awaited<ReturnType<typeof tauriFetch>>
        try {
          initRes = await tauriFetch(`${workerUrl}/v1/projects/deploy/init`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              projectId: project.id,
              projectName: project.name,
            }),
          })
        } catch (err) {
          return `Failed to reach deploy/init: ${err instanceof Error ? err.message : String(err)}`
        }
        if (!initRes.ok) {
          const body = await initRes.text().catch(() => '')
          // Surface the structured DEPLOY_QUOTA / subscription codes so the
          // agent can offer the right next step (upgrade vs. remove existing).
          return `Deploy init failed (HTTP ${initRes.status}): ${body.slice(0, 300)}`
        }
        const initData = (await initRes.json()) as { slug?: string }
        const slug = initData.slug
        if (!slug) {
          return 'Init returned without a slug — unexpected response shape.'
        }

        // Write APP_ID to .env. APP_ID is the project.id (same identifier
        // used in projectDeployments + the path namespace under
        // apps/{APP_ID}/... in Firestore). GCP_PROJECT_ID is already there
        // from provision_auth; no other vars to add.
        const envVars: Array<{ key: string; value: string }> = [
          { key: 'APP_ID', value: project.id },
        ]
        try {
          await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
        } catch (err) {
          return `Reserved slug "${slug}" but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
        }

        // Invalidate scaffolding cache so detection picks up the new vars.
        try {
          const { invalidateScaffoldingCache } = await import('../scaffoldingDetector')
          invalidateScaffoldingCache(project.path)
        } catch { /* non-critical */ }

        const lines: string[] = []
        lines.push(`Deploy infrastructure ready for "${project.name}".`)
        lines.push(`  - Public hostname: ${slug}.toquemedia.net (locked to this project)`)
        lines.push(`  - Data namespace: apps/${project.id}/... (platform-managed)`)
        lines.push(`  - .env written: APP_ID`)
        lines.push('')
        lines.push('## What to do next')
        lines.push('')
        lines.push(`1. Confirm the publish-ready code shape is already in place (it should be — that's the platform default): firebase-admin data layer with the local-dev APP_ID fallback, Dockerfile + cloudbuild.yaml at root, read-once + in-memory cache pattern applied. If anything is missing, read_skill("${PUBLISHING_SKILL_NAME}") and fill the gaps.`)
        lines.push('2. The developer can now click Publish — the IDE handles build + bring-online from there.')
        lines.push('')
        lines.push('CREDENTIALS COMPLETE — do NOT call request_credentials for database / cloud / service-account keys. The platform runtime authenticates natively (no JSON keys, no API tokens). The only env vars the backend reads at runtime are APP_ID + the auth keys provision_auth already wrote.')

        return lines.join('\n')
      },
    })

    // === request_credentials ===
    // Renders a secure form in the chat for collecting API keys, tokens, and
    // secrets. The form is the ONLY legitimate write path for the project's
    // .env file (the agent's normal write/read tools are mechanically blocked
    // from .env). Values never enter the chat history or the model context —
    // the tool result only echoes the keys that were saved.
    this.tools.set('request_credentials', {
      definition: {
        name: 'request_credentials',
        description:
          'Request API keys, tokens, or other secrets from the developer via a secure form rendered inline in the chat. The form writes the values directly into the project .env (which is otherwise unreadable and unwritable by the agent). Never instruct the developer to create or edit .env manually, and never ask them to paste secrets into the chat.\n\nUSE FOR: third-party services the developer is integrating into their app (OpenAI, Anthropic, Stripe, SendGrid, Twilio, Resend, generic webhooks, etc.).\n\nSKIP FOR: anything the platform manages — authentication, the platform database, the runtime, the build pipeline. provision_auth writes the auth credentials automatically; the developer does not have (and will never have) admin SDK keys, service-account files, or infrastructure tokens for the platform side. Those live only on the platform worker. Requesting them through this form is incorrect and will confuse the developer.',
        input_schema: {
          type: 'object',
          properties: {
            service_name: {
              type: 'string',
              description: 'Name of the service the credentials are for (e.g. "OpenAI", "Stripe", "Firebase")',
            },
            fields: {
              type: 'array',
              description: 'Credential fields to collect. Maximum 8 per request.',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Env var key as it will appear in .env (UPPER_SNAKE_CASE, e.g. "OPENAI_API_KEY")',
                  },
                  label: {
                    type: 'string',
                    description: 'Human-readable label shown in the form',
                  },
                  type: {
                    type: 'string',
                    enum: ['text', 'password'],
                    description: 'Use "password" for API keys, tokens, secrets. Use "text" for non-sensitive values like project IDs.',
                  },
                  required: {
                    type: 'boolean',
                    description: 'Whether the field must be filled before the user can submit',
                  },
                  helperText: {
                    type: 'string',
                    description: 'Optional hint shown below the field (e.g. "Find this at https://...")',
                  },
                },
                required: ['id', 'label', 'type', 'required'],
              },
            },
          },
          required: ['service_name', 'fields'],
        },
      },
      execute: async (input) => {
        const serviceName = String(input.service_name || '').trim()
        if (!serviceName) {
          return 'Missing required parameter: service_name'
        }

        const rawFields = input.fields
        if (!Array.isArray(rawFields) || rawFields.length === 0) {
          return 'Missing required parameter: fields (must be a non-empty array)'
        }
        if (rawFields.length > 8) {
          return 'Too many fields: maximum 8 per request. Group related credentials into separate calls.'
        }

        const fields: Array<{
          id: string
          label: string
          type: 'text' | 'password'
          required: boolean
          helperText?: string
        }> = []
        const seenIds = new Set<string>()
        for (const raw of rawFields as Array<Record<string, unknown>>) {
          const id = String(raw?.id ?? '').trim()
          const label = String(raw?.label ?? '').trim()
          if (!id || !label) {
            return 'Each field must have non-empty "id" and "label".'
          }
          if (!/^[A-Z_][A-Z0-9_]*$/.test(id)) {
            return `Field id "${id}" is not a valid env var key (must match /^[A-Z_][A-Z0-9_]*$/).`
          }
          // Mechanical blocklist for platform-managed credentials. These are
          // written by provision_auth / provision_deploy when those tools
          // succeed; asking the developer for them surfaces a form they
          // cannot satisfy. Documented in the auth-proxy skill's hard rules
          // (rule #2). The prose-only directive in the tool description was
          // ignored repeatedly (BugHunter session 2026-05-16) when
          // provision_auth failed and the model fell back to "let me just
          // ask the developer for these" — so the gate is now mechanical.
          const blockReason = describePlatformManagedField(id)
          if (blockReason) {
            return blockReason
          }
          if (seenIds.has(id)) {
            return `Duplicate field id "${id}".`
          }
          seenIds.add(id)
          const type = raw?.type === 'text' ? 'text' : 'password'
          fields.push({
            id,
            label,
            type,
            required: raw?.required !== false,
            helperText: raw?.helperText ? String(raw.helperText).trim() : undefined,
          })
        }

        const projectRoot = this.getProjectRoot()
        if (!projectRoot) {
          return 'No active project — cannot collect credentials. Open a project first.'
        }

        const { useCredentialRequestStore } = await import('../../stores/credentialRequestStore')
        const chatStore = useChatStore.getState()

        // request() is synchronous — returns the id and a promise we await
        // below. We race the promise against the abort signal so the tool
        // unblocks immediately if the loop is cancelled.
        const { id: requestId, promise: requestPromise } = useCredentialRequestStore
          .getState()
          .request({ serviceName, fields })

        const cardMessageId = chatStore.addCredentialRequestCard(
          projectRoot,
          requestId,
          serviceName,
          fields,
        )

        const abortSignal = input._abortSignal as AbortSignal | undefined

        const result = await new Promise<{ submitted: boolean; keys?: string[] }>((resolve) => {
          let settled = false
          const onAbort = () => {
            if (settled) return
            settled = true
            useCredentialRequestStore.getState().cancel(requestId)
            resolve({ submitted: false })
          }
          if (abortSignal) {
            if (abortSignal.aborted) {
              onAbort()
              return
            }
            abortSignal.addEventListener('abort', onAbort, { once: true })
          }
          requestPromise.then((r) => {
            if (settled) return
            settled = true
            resolve(r)
          })
        })

        if (result.submitted) {
          chatStore.markCredentialRequestSubmitted(cardMessageId, result.keys ?? [])
          const keysList = (result.keys ?? []).join(', ') || '(none)'
          return `Credentials saved to .env for ${serviceName}: ${keysList}. Values are masked from the chat history. Continue with the implementation.`
        }

        chatStore.updateCardStatus(cardMessageId, 'cancelled')
        return `User cancelled the credential request for ${serviceName}. Ask the user how they want to proceed without these credentials.`
      },
    })

    this.tools.set('verify', {
      definition: {
        name: 'verify',
        description: 'Launch an independent verification agent that checks your implementation by running tests, reading code, and executing diagnostic commands. The verifier CANNOT edit files — it can only read and execute. Use after completing non-trivial changes (3+ files, backend/API work, complex logic) to catch issues before reporting done. Returns a verdict: PASS, FAIL, or PARTIAL. NOTE: For quick TypeScript type checking, prefer execute_command("npx tsc --noEmit 2>&1") instead — it is faster and more direct than launching the full verify sub-agent.',
        input_schema: {
          type: 'object',
          properties: {
            task_description: { type: 'string', description: 'What was the original task/requirement' },
            files_changed: { type: 'array', items: { type: 'string' }, description: 'List of absolute file paths that were modified' },
            approach: { type: 'string', description: 'Brief description of how you implemented it' }
          },
          required: ['task_description', 'files_changed']
        }
      },
      execute: async (input) => {
        const taskDescription = input.task_description as string
        const filesChanged = (input.files_changed as string[]) || []
        const approach = (input.approach as string) || ''

        const { default: AgentService } = await import('./agentService')

        // Verification agent: read-only + execute (NO write/edit/create tools).
        // execute_command gets a modified description warning about read-only restrictions.
        const verifierToolNames = new Set([
          'read_file', 'list_directory', 'search_files', 'glob',
          'get_diagnostics', 'execute_command', 'read_dev_server_logs',
          'read_large_result',
        ])
        const verifierTools = this.getToolDefinitions()
          .filter(t => verifierToolNames.has(t.function.name))
          .map(t => {
            // Annotate execute_command description with read-only constraint
            if (t.function.name === 'execute_command') {
              return {
                ...t,
                function: {
                  ...t.function,
                  description: t.function.description + ' RESTRICTION: You are a read-only verification agent. Only run diagnostic commands (tests, linters, type checkers, curl). Do NOT run commands that modify files (no redirects >, >>, no sed -i, no mv/cp/rm, no tee, no mkdir/touch).',
                }
              }
            }
            return t
          })

        // Phase B: derive verify agent abort from the per-call signal.
        const verifyAbort = createLinkedAbortController(input._abortSignal as AbortSignal | undefined)
        const subAgent = AgentService.createLightweight({
          tools: verifierTools,
          readOnly: true,
          maxTurns: 30,
          abortController: verifyAbort,
        })

        const projectRoot = this.getProjectRoot()
        const systemPrompt = `You are a verification specialist. Your job is not to confirm the implementation works — it's to try to break it.

You have two failure patterns to avoid. First, verification avoidance: reading code, narrating what you would test, writing "PASS," and moving on. Second, being seduced by the first 80%: a passing test suite while half the logic is broken on edge cases.

=== CRITICAL: DO NOT MODIFY THE PROJECT ===
You CANNOT create, modify, or delete any files in the project. You can only read and execute.
You MAY write ephemeral test scripts to /tmp via execute_command when needed. Clean up after.

=== VERIFICATION STRATEGY ===
Adapt based on what was changed:
- **Frontend**: Check read_dev_server_logs for errors → run frontend tests if they exist
- **Backend/API**: Start server → curl/fetch endpoints → verify response shapes → test error handling → edge cases
- **Bug fixes**: Reproduce the original bug → verify fix → check for side effects
- **Refactoring**: Existing tests MUST pass unchanged → spot-check behavior is identical

=== REQUIRED STEPS ===
1. Read TMS.md / package.json for build/test commands.
2. Run the build (if applicable). Broken build = automatic FAIL.
3. Run the project's test suite (if it exists). Failing tests = automatic FAIL.
4. Run linters/type-checkers if configured (eslint, tsc --noEmit).
5. Apply the type-specific strategy above.

=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===
- "The code looks correct based on my reading" — reading is not verification. Run it.
- "The implementer's tests already pass" — verify independently.
- "This is probably fine" — probably is not verified. Run it.
If you catch yourself writing an explanation instead of a command, stop. Run the command.

=== OUTPUT FORMAT ===
Every check MUST follow this structure:

### Check: [what you're verifying]
**Command run:** [exact command]
**Output observed:** [actual output — copy-paste, not paraphrased]
**Result: PASS** (or FAIL — with Expected vs Actual)

A check without a Command run block is not a PASS — it's a skip.

End with exactly one of:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

PARTIAL is for environmental limitations only (no test framework, tool unavailable) — not for "I'm unsure."

Project root: ${projectRoot}`

        subAgent.setSystemPrompt(systemPrompt)

        const prompt = `## Task
${taskDescription}

## Approach
${approach || '(not provided)'}

## Files changed
${filesChanged.map(f => `- ${f}`).join('\n')}

Verify this implementation. Run tests, type checks, and any other relevant validation. End with your VERDICT.`

        let result = ''
        let totalTokens = 0
        let toolsCalled = 0
        const toolCallId = input._toolCallId as string | undefined

        const updateProgress = (status: string) => {
          if (toolCallId) {
            const tokenStr = totalTokens > 0 ? ` | ${Math.round(totalTokens / 1000)}K tokens` : ''
            useChatStore.getState().updateToolCallProgress(toolCallId, `🔍 ${status}${tokenStr}`)
          }
        }

        updateProgress('Starting verification...')

        // Activate read-only mode to block file-writing shell commands.
        // Uses a scoped context ID so concurrent background agents aren't affected.
        const readOnlyId = this.enterReadOnlyMode()
        try {
        // Forward every sub-agent event to the main chatStore — see
        // src/services/agent/subAgentVisibility.ts for the shared wiring.
        const chatStore = useChatStore.getState()
        const { useAgentStore } = await import('../../stores/agentStore')
        const agentStore = useAgentStore.getState()
        const { createSubAgentVisibility } = await import('./subAgentVisibility')

        const visibility = createSubAgentVisibility({
          parentToolCallId: toolCallId,
          reasoningLabel: 'verify sub-agent',
          hooks: {
            appendTextDelta: chatStore.appendTextDelta,
            appendReasoningDelta: chatStore.appendReasoningDelta,
            addPendingToolCall: chatStore.addPendingToolCall,
            updateToolCallWithArgs: chatStore.updateToolCallWithArgs,
            updateToolCallWithResult: chatStore.updateToolCallWithResult,
            setStatus: (s) => agentStore.setStatus(s),
          },
        })

        await subAgent.runAgentLoop(prompt, [], {
          onTextDelta: (delta) => {
            result += delta
            visibility.callbacks.onTextDelta(delta)
          },
          onReasoningDelta: (delta) => {
            visibility.callbacks.onReasoningDelta(delta)
            updateProgress('Analyzing...')
          },
          onToolCallPending: (childId, toolName) => {
            toolsCalled++
            visibility.callbacks.onToolCallPending(childId, toolName)
            updateProgress(`${toolName}...`)
          },
          onToolCallStart: (childId, toolName, args) => {
            visibility.callbacks.onToolCallStart(childId, toolName, args)
            const target = (args.path as string)?.replace(/\\/g, '/').split('/').pop()
              || (args.command as string)?.slice(0, 40)
              || (args.query as string)
              || ''
            updateProgress(`${toolName}: ${target}`)
          },
          onToolResult: (childId, toolName, res, isError) => {
            visibility.callbacks.onToolResult(childId, toolName, res, isError)
          },
          onTurnComplete: () => {},
          onDone: (finalText) => {
            if (finalText && !result) result = finalText
            updateProgress(`Done — ${toolsCalled} checks`)
          },
          onError: (error) => {
            result = `Verification error: ${error.message}`
            visibility.cleanupOrphans(`aborted: verify sub-agent failed — ${error.message}`)
            updateProgress('Error')
          },
          onUsageUpdate: (inputTokens, outputTokens) => {
            totalTokens += inputTokens + outputTokens
          },
        } satisfies AgentCallbacks)

        return result || 'Verification produced no output.'
        } finally {
          this.exitReadOnlyMode(readOnlyId)
        }
      }
    })
  }
}

export default ToolExecutor
