import { invoke } from '@/utils/invokeMetrics'
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
  describePlatformManagedField,
  normalizePath,
  isEnvFile,
  isSensitiveFile,
  simpleHash,
  matchDangerousCommand,
  matchStateMutatingCommand,
  WRITE_COMMAND_PATTERNS,
  DANGEROUS_COMMANDS,
  STATE_MUTATING_COMMANDS,
  checkForbiddenAuthImports,
  checkForbiddenItkV2,
  checkForbiddenServiceAccountImport,
  checkForbiddenDataLayerDeps,
  checkForbiddenDockerfileShape,
} from './toolExecutor/checks'
import { tauriFetch } from '../tauriFetch'
import { devServerManager } from '../devServerManager'
import { resolveWorkerUrl, resolveDeployUrl } from '../../utils/devUrls'
import { formatError } from '../../utils/errors'
import { checkPlanModeAccess, isPlanArtefactAtRoot } from './planMode'
import { READ_FILE, WRITE_FILE, EDIT_FILE } from './toolNames'
// TypeScriptLspService removed — get_diagnostics now uses npx tsc directly
import CheckpointService from './checkpointService'
import type { MCPTool } from '../mcp/mcpService'
import type { AgentCallbacks } from './agentService'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered } from '../../stores/chatStore'

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

// Platform-managed credential gate (`PLATFORM_MANAGED_FIELD_IDS` /
// `describePlatformManagedField`) moved to `./toolExecutor/checks` — see
// the import block above. The set + describer are re-exported there with
// the same identity so the existing call sites in this file (and any
// future caller) keep using the canonical name.

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
    this.largeResultsTotalBytes = 0
    this.largeResultRangesShown.clear()
    this.largeResultCounter = 0
    this.readOnlyContexts.clear()
  }

  /**
   * Evict the oldest large result and update the incremental byte counter.
   * Used by both the byte-cap and entry-count eviction loops in
   * `truncateResult` — single source of truth for the bookkeeping.
   */
  private evictOldestLargeResult(): void {
    const firstKey = this.largeResults.keys().next().value
    if (!firstKey) return
    const removed = this.largeResults.get(firstKey)
    this.largeResults.delete(firstKey)
    this.largeResultRangesShown.delete(firstKey)
    if (removed) this.largeResultsTotalBytes -= removed.length
  }

  /**
   * Merge a new `[offset, end)` range into the per-id ranges-shown list,
   * coalescing with any existing ranges it touches. Keeps the list flat
   * and small even after many sequential reads — three reads at 0-2k,
   * 2k-4k, 4k-6k collapse to a single `[0, 6000)` entry. Returns the
   * single range that the new read overlapped with (for the model's
   * overlap warning), or `null` if there was no overlap.
   */
  private trackShownRange(id: string, offset: number, end: number): [number, number] | null {
    const ranges = this.largeResultRangesShown.get(id) ?? []
    // Find every existing range that touches [offset, end) — they all merge.
    let mergedStart = offset
    let mergedEnd = end
    let firstOverlap: [number, number] | null = null
    const survivors: Array<[number, number]> = []
    for (const r of ranges) {
      if (r[0] <= mergedEnd && mergedStart <= r[1]) {
        if (!firstOverlap) firstOverlap = [r[0], r[1]]
        mergedStart = Math.min(mergedStart, r[0])
        mergedEnd = Math.max(mergedEnd, r[1])
      } else {
        survivors.push(r)
      }
    }
    survivors.push([mergedStart, mergedEnd])
    // Re-sort by start so future overlap checks see ascending ranges.
    survivors.sort((a, b) => a[0] - b[0])
    this.largeResultRangesShown.set(id, survivors)
    return firstOverlap
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
  /** Incremental byte counter kept in sync with `largeResults` set/delete
   *  ops. Avoids the O(N) `for ... values()` total-scan that the byte-cap
   *  eviction loop used to do on every `truncateResult` call. */
  private largeResultsTotalBytes = 0
  /** Per-id ranges already shown to the model (S1: overlap warnings on
   *  re-read). Stored as `[offset, end)` pairs MERGED on insert — so
   *  three sequential reads (0-2k, 2k-4k, 4k-6k) collapse to a single
   *  [0, 6000) instead of fragmenting. The whole entry is dropped when
   *  the large result itself is evicted. */
  private largeResultRangesShown: Map<string, Array<[number, number]>> = new Map()
  /** Approximate cap on total bytes held across all cached large results
   *  (S2). When a new result would push past the cap, the oldest entries
   *  are evicted until we fit. Independent from the entry-count cap below. */
  private static readonly LARGE_RESULT_MAX_BYTES = 8 * 1024 * 1024 // 8MB
  private static readonly LARGE_RESULT_MAX_ENTRIES = 20

  /**
   * Handles large tool results: if the result exceeds the threshold,
   * stores the full output in memory and returns a reference with a preview.
   * The model can retrieve the full output via read_large_result tool.
   * This prevents information loss from truncation (like Claude Code's disk persistence).
   */
  private truncateResult(result: string, maxChars: number = 30000): string {
    if (result.length <= maxChars) return result

    // Store full result in memory for later retrieval. Update the
    // incremental byte counter so eviction doesn't have to total-scan.
    const refId = `large_result_${++this.largeResultCounter}`
    this.largeResults.set(refId, result)
    this.largeResultsTotalBytes += result.length

    // S2: byte-budget eviction. Pop oldest until we fit under the cap.
    // O(K) where K is the number of entries evicted, not O(N) like before.
    while (
      this.largeResultsTotalBytes > ToolExecutor.LARGE_RESULT_MAX_BYTES
      && this.largeResults.size > 1
    ) {
      this.evictOldestLargeResult()
    }

    // B4: count-cap eviction. Keep the most recent N entries.
    while (this.largeResults.size > ToolExecutor.LARGE_RESULT_MAX_ENTRIES) {
      this.evictOldestLargeResult()
    }
    const nearCap = this.largeResults.size >= ToolExecutor.LARGE_RESULT_MAX_ENTRIES - 2

    const previewSize = 2000
    const preview = result.slice(0, previewSize)
    const totalSize = result.length > 1024
      ? `${(result.length / 1024).toFixed(1)}KB`
      : `${result.length} chars`

    // B1: was "byte ${previewSize}" — the unit is JS string code units,
    //     not bytes (matters for non-ASCII content like emoji / CJK).
    // B2: explicit offset-to-continue, so the model doesn't waste a call
    //     re-reading the preview region from offset 0.
    // B3: terminology now matches the read_large_result suffix.
    // B4: cap-approaching nudge.
    const capNote = nearCap
      ? ` [warning: ${this.largeResults.size}/${ToolExecutor.LARGE_RESULT_MAX_ENTRIES} cached large results — oldest will be evicted as new ones arrive; save what you need now.]`
      : ''
    return `<system-reminder>Partial view: this tool produced ${totalSize} of output but only the first ${previewSize} characters are shown below. Continue from offset ${previewSize} unless you need a specific slice — call read_large_result("${refId}", offset: ${previewSize}). Do not reason about content past character ${previewSize} from this preview alone.${capNote}</system-reminder>

Preview (first ${previewSize} characters):
${preview}
...
`
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

  // normalizePath moved to ./toolExecutor/checks — thin wrapper kept for the
  // private call sites (this.normalizePath) that haven't been updated.
  private normalizePath(p: string): string { return normalizePath(p) }

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

  // Forbidden pattern checks moved to ./toolExecutor/checks — thin wrappers
  // kept so existing private-method call sites (this.checkForbiddenAuthImports
  // etc.) continue to work without rewrites. Same applies to .env / sensitive
  // detection just below. Bodies live in the imported pure functions; the
  // class is now an orchestrator.
  private checkForbiddenAuthImports(path: string, content: string): string | null {
    return checkForbiddenAuthImports(path, content)
  }
  private checkForbiddenItkV2(path: string, content: string): string | null {
    return checkForbiddenItkV2(path, content)
  }
  private checkForbiddenServiceAccountImport(path: string, content: string): string | null {
    return checkForbiddenServiceAccountImport(path, content)
  }
  private async checkForbiddenDockerfileShape(path: string, content: string): Promise<string | null> {
    return checkForbiddenDockerfileShape(path, content)
  }
  private checkForbiddenDataLayerDeps(path: string, newContent: string, oldContent: string = ''): string | null {
    return checkForbiddenDataLayerDeps(path, newContent, oldContent)
  }
  private isEnvFile(filePath: string): boolean {
    return isEnvFile(filePath)
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

  // Dangerous command lists + sensitive-file detection moved to
  // ./toolExecutor/checks — wrappers preserve the existing private call
  // sites. Static lists are re-exported for the Settings UI; the wrappers
  // below cover the instance-method usages inside this class.
  private isSensitiveFile(filePath: string): boolean { return isSensitiveFile(filePath) }
  static readonly DANGEROUS_COMMANDS = DANGEROUS_COMMANDS
  static readonly STATE_MUTATING_COMMANDS = STATE_MUTATING_COMMANDS
  private matchDangerousCommand(command: string): string | null { return matchDangerousCommand(command) }
  private matchStateMutatingCommand(command: string): string | null { return matchStateMutatingCommand(command) }

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


  // WRITE_COMMAND_PATTERNS moved to ./toolExecutor/checks — referenced
  // below via a static getter so existing `ToolExecutor.WRITE_COMMAND_PATTERNS`
  // call sites keep working.
  private static readonly WRITE_COMMAND_PATTERNS = WRITE_COMMAND_PATTERNS

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

  // simpleHash moved to ./toolExecutor/checks — thin wrapper for existing
  // `this.simpleHash(...)` call sites.
  private simpleHash(str: string): number { return simpleHash(str) }

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
        description: 'Read the contents of a file at the given file_path. By default reads the entire file; for large files use `offset` + `limit` to read a line range (1-indexed), matching Claude Code\'s Read tool semantics. Files larger than 256 KB throw with instructions to use offset/limit — auto-truncating would waste 25K+ tokens of context vs. the model refining its call.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to read' },
            offset: { type: 'number', description: '1-indexed line number to start from. Combine with `limit` to read a slice of a large file.' },
            limit: { type: 'number', description: 'Maximum number of lines to read. Default: read to end of file.' }
          },
          required: ['file_path']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const filePath = input.file_path as string
        // Detect "provided" BEFORE clamping — Math.max(1, 0) would turn
        // a missing offset into 1 and make sliceRequested always true.
        const offsetProvided = typeof input.offset === 'number' && input.offset > 0
        const limitProvided = typeof input.limit === 'number' && input.limit > 0
        const offset = offsetProvided ? Math.max(1, input.offset as number) : 1
        const limit = limitProvided ? Math.max(1, input.limit as number) : 0
        const sliceRequested = offsetProvided || limitProvided
        this.validatePathWithinProject(filePath)
        try {
          const MAX_FILE_BYTES = 256 * 1024
          const fullContent = await invoke<string>('read_file', { path: filePath })

          // Byte-size guard (claude-vaz adoption, FileReadTool/limits.ts).
          // The cheap pre-flight stat that claude-vaz uses isn't available
          // on the Rust side yet, so we check AFTER read — still buys us
          // throw-and-instruct (the 256 KB doesn't ship to the model;
          // only a ~150-byte error does), which the claude-vaz #21841
          // experiment showed beats auto-truncation in mean token cost.
          // Skipped when the model is explicitly slicing — that's the
          // refinement path the error tells it to use.
          if (!sliceRequested && fullContent.length > MAX_FILE_BYTES) {
            void import('../../services/analytics').then(({ trackEvent }) => {
              trackEvent('read_file_oversize_throw', {
                path: filePath,
                size_kb: Math.round(fullContent.length / 1024),
              })
            }).catch(() => {})
            return `Error: File is ${(fullContent.length / 1024).toFixed(1)} KB which exceeds the 256 KB read cap. Use \`offset\` + \`limit\` to read a line range, or use search_files / glob to locate specific content. Reading the whole file would saturate the output budget for one call.`
          }

          // Apply line-based slice if requested. Lines are 1-indexed for
          // model parity with Claude Code's Read tool.
          let content = fullContent
          if (sliceRequested) {
            const lines = fullContent.split('\n')
            const start = Math.max(0, offset - 1)
            const end = limit > 0 ? start + limit : lines.length
            const slice = lines.slice(start, end)
            const hasMore = end < lines.length
            content = slice.join('\n')
            if (hasMore) {
              const nextOffset = end + 1
              content += `\n\n[truncated at line ${end} of ${lines.length}; use offset: ${nextOffset} to continue]`
            }
          }
          const newHash = this.simpleHash(fullContent)

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

          // Empty content: distinguish "file is empty" (no slice requested,
          // file genuinely has no bytes) from "slice past EOF" (model paged
          // beyond the last line) — generic "empty" message would mislead.
          if (content.length === 0) {
            if (sliceRequested && fullContent.length > 0) {
              const totalLines = fullContent.split('\n').length
              return `<system-reminder>The slice (offset ${offset}${limit > 0 ? `, limit ${limit}` : ''}) is past the end of the file. The file has ${totalLines} lines; pick an offset within range.</system-reminder>`
            }
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
            return `Error: You must ${READ_FILE}("${path}") before overwriting it. Read the file first to understand its current content, then call ${WRITE_FILE}.`
          }
          // Concurrent modification detection: check if file changed on disk since the model read it
          const currentHash = this.simpleHash(oldContent)
          if (currentHash !== readState.hash) {
            this.readFileTimestamps.delete(path)
            return `Error: File "${path}" has been modified since you last read it (by the developer, a formatter, or another process). Read it again with ${READ_FILE} before writing.`
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
          return `Error: File already exists: ${path}. Use ${WRITE_FILE} to overwrite or ${EDIT_FILE} for small changes.`
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
        description: 'Replace a specific string in a file with new content. The old_string must match exactly and appear only once in the file. Use this for surgical edits instead of rewriting entire files with write_file. Field names match Claude Code\'s Edit tool: `old_string` / `new_string`.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to edit' },
            old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique in the file.' },
            new_string: { type: 'string', description: 'Text to replace old_string with. Use empty string to delete.' }
          },
          required: ['path', 'old_string', 'new_string']
        }
      },
      execute: async (input) => {
        const path = input.path as string
        // Field names align with Claude Code's Edit tool — the model uses
        // these from training. Background: the May 2026 todo-mimo /plan
        // session looped when the schema was old_str-only; the model
        // defaulted to old_string (its training default) and the original
        // "cannot be empty" error gave no hint about the key-name issue.
        const oldStr = (input.old_string ?? '') as string
        const newStr = (input.new_string ?? '') as string

        if (!oldStr) {
          // Detect known typos (camelCase, snake_str legacy, alternate
          // editor names) so the error tells the model exactly what to
          // fix instead of just "empty" — which it can't act on if the
          // value was actually there under a misspelled key.
          const passedKeys = Object.keys(input).filter(k => !k.startsWith('_'))
          const wrongName = passedKeys.find(k =>
            k === 'oldStr' || k === 'oldString' || k === 'old_text' ||
            k === 'old_str' || k === 'new_str',
          )
          // Fire-and-forget telemetry (#22 from prompt techniques manual).
          // Without this we can't tell if the field-name fixes reduced
          // the loop rate or just shifted it. `kind` lets us slice by
          // failure mode in the dashboard.
          void import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('edit_file_error', {
              kind: wrongName ? 'typo' : 'empty_old_string',
              wrong_name: wrongName ?? '',
            })
          }).catch(() => { /* never block on telemetry */ })
          if (wrongName) {
            return `Error: this tool expects \`old_string\` (and \`new_string\`). You passed: ${passedKeys.join(', ')}. Rename your field to old_string / new_string and retry.`
          }
          return 'Error: old_string cannot be empty. Provide the exact text you want to replace.'
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
          return `Error: You must ${READ_FILE}("${path}") before editing it. Read the file first to see the current content, then call ${EDIT_FILE}.`
        }

        const content = await invoke<string>('read_file', { path })

        // Concurrent modification detection
        const currentHash = this.simpleHash(content)
        if (currentHash !== readState.hash) {
          this.readFileTimestamps.delete(path)
          return `Error: File "${path}" has been modified since you last read it. Read it again with ${READ_FILE} before editing.`
        }

        const occurrences = content.split(oldStr).length - 1

        if (occurrences === 0) {
          void import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('edit_file_error', { kind: 'not_found', wrong_name: '' })
          }).catch(() => {})
          return `Error: old_string not found in ${path}. The content you're trying to replace doesn't exist in the file. Read the file first to see the current content.`
        }

        if (occurrences > 1) {
          // Two failure modes look identical here — see editLiteralReplace.ts
          // for the full reasoning. Pure function so production and tests
          // can't drift.
          const { duplicateMatchError } = await import('./editLiteralReplace')
          void import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('edit_file_error', { kind: 'non_unique', wrong_name: '', occurrences })
          }).catch(() => {})
          return duplicateMatchError(path, occurrences)
        }

        // Literal substring replace — see editLiteralReplace.ts for the
        // $-sequence corruption history. Pure function so production and
        // tests can't drift.
        const { editFileReplace } = await import('./editLiteralReplace')
        const newContent = editFileReplace(content, oldStr, newStr)

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

        const workerUrl = resolveWorkerUrl()

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
        const end = Math.min(offset + limit, content.length)
        const slice = content.slice(offset, offset + limit)
        const hasMore = end < content.length
        const remaining = content.length - end

        // S1: detect overlap with ranges already read in this session for
        // this large_result id, AND coalesce adjacent ranges so the list
        // stays small. trackShownRange returns the first range the new
        // read overlapped with — null when there was no overlap.
        const overlapping = this.trackShownRange(id, offset, end)

        let result = slice
        const notes: string[] = []
        if (overlapping) {
          notes.push(`note: offset ${offset}–${end} overlaps with a slice you already read (${overlapping[0]}–${overlapping[1]}). The overlap region is duplicated in your context.`)
        }
        if (hasMore) {
          notes.push(`${remaining} more characters — use offset: ${end} to continue reading.`)
        }
        if (notes.length > 0) {
          result += `\n\n[${notes.join(' ')}]`
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
            context: { type: 'string', description: 'Optional context to help the sub-agent (e.g., relevant file paths, what you already know)' },
            thoroughness: {
              type: 'string',
              enum: ['quick', 'medium', 'thorough'],
              description: 'How much effort the sub-agent should spend. "quick" = single targeted lookup (1-3 tool calls, one location); "medium" = moderate exploration (3-8 tool calls, a few related locations); "thorough" = comprehensive search across multiple locations and naming conventions. You have the context to pick — choose the smallest that will answer the question. Defaults to "medium" when omitted.'
            }
          },
          required: ['question']
        }
      },
      execute: async (input) => {
        const question = input.question as string
        const context = (input.context as string) || ''
        const thoroughness = (input.thoroughness as 'quick' | 'medium' | 'thorough' | undefined) ?? 'medium'

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
        // Caller-parameterized verbosity (technique #17). The parent agent
        // knows whether this is a quick "where is X defined" probe or a
        // deep refactor investigation — pass it through so the sub-agent
        // calibrates effort accordingly. Wrong-sized effort is the most
        // expensive failure mode: "thorough" on a 1-file question wastes
        // turns; "quick" on a refactor question misses the bug.
        const effortDirective = thoroughness === 'quick'
          ? '**Effort: QUICK** — single targeted lookup. Stop after 1-3 tool calls. Do not branch into related questions — answer the literal question and return.'
          : thoroughness === 'thorough'
            ? '**Effort: THOROUGH** — comprehensive search. Cover multiple locations and naming conventions, follow related references, read full files (not snippets) when relevant. Report what you searched, not just what you found.'
            : '**Effort: MEDIUM** — moderate exploration. Check 2-3 likely locations, follow references one hop deep, then synthesise. Do not exhaustively enumerate; do not stop at the first plausible match.'
        const systemPrompt = `You are a sub-agent inside TM Code. Complete the task using the available tools. You can read, create, edit, and search files, AND search the internet for information.

${effortDirective}

Available tools:
- File operations: read_file, write_file, create_file, edit_file
- Search: search_files (ripgrep), glob, list_directory
- Web research:
  - web_search — takes a natural-language query and returns ranked results with titles, snippets, and URLs. This is how you discover what pages exist on a topic.
  - web_fetch — takes one complete target URL you already know and returns the contents of that single page. This is how you read the body of a specific article, doc, or API reference.
  - Typical flow: start with web_search to find relevant URLs, then web_fetch on the most promising result to read its full content.
- Diagnostics: get_diagnostics

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
            // Buffered variants — sub-agent SSE bumps streamingVersion at
            // the same 50ms cadence as the parent agent loop. Without the
            // swap, every sub-agent token was a fresh re-render of the
            // streaming bubble even though the parent had already batched
            // its own.
            appendTextDelta: appendTextDeltaBuffered,
            appendReasoningDelta: appendReasoningDeltaBuffered,
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
            thoroughness: {
              type: 'string',
              enum: ['quick', 'medium', 'thorough'],
              description: 'How much effort the background agent should spend. "quick" = single targeted probe; "medium" = moderate exploration; "thorough" = comprehensive multi-location search. Background agents have a 30-turn cap, so "thorough" may still be bounded. Defaults to "medium" when omitted.'
            },
          },
          required: ['question']
        }
      },
      execute: async (input) => {
        const question = input.question as string
        const context = (input.context as string) || ''
        const thoroughness = (input.thoroughness as 'quick' | 'medium' | 'thorough' | undefined) ?? 'medium'

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
        // Caller-parameterized verbosity (technique #17). Parent picks the
        // effort level based on what they actually need; the background
        // agent calibrates rather than always running at full thoroughness.
        const effortDirective = thoroughness === 'quick'
          ? '**Effort: QUICK** — single targeted probe. Stop after 1-3 tool calls.'
          : thoroughness === 'thorough'
            ? '**Effort: THOROUGH** — comprehensive multi-location search (bounded by the 30-turn cap). Cover alternative naming conventions and follow related references.'
            : '**Effort: MEDIUM** — moderate exploration. 2-3 likely locations, references one hop deep, then synthesise.'
        subAgent.setSystemPrompt(
          `You are a background research agent inside TM Code. Investigate the task using read-only tools and produce a clear summary.\n\n${effortDirective}\n\nProject root: ${projectRoot}`
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
            // Buffered variants — sub-agent SSE bumps streamingVersion at
            // the same 50ms cadence as the parent agent loop. Without the
            // swap, every sub-agent token was a fresh re-render of the
            // streaming bubble even though the parent had already batched
            // its own.
            appendTextDelta: appendTextDeltaBuffered,
            appendReasoningDelta: appendReasoningDeltaBuffered,
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
        description: 'Create or update a task list visible to the developer in the chat UI. Use at the start of complex work to show what you plan to do, and update task statuses as you complete each step. The developer sees checkboxes with real-time progress.\n\n**Completion contract — each `completed` flip is a claim that THAT specific task\'s acceptance was verified** (test passed, endpoint smoked successfully, diff approved AND behaviour confirmed). Filesystem existence is not completion: a scaffold file written in a previous turn does NOT mean the task that creates it is done.\n\n**One transition per call is the norm.** When resuming after an interruption, do NOT flip multiple pending tasks to completed in a single call by inferring from the filesystem — the tool returns a warning in that case so the call can be reconsidered. Legitimate batch transitions only happen at seed time (all `pending`) or at the very end of a flow (every task already verified one-by-one in prior calls).',
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

        // Capture the previous tracker BEFORE applying the new state so we
        // can detect batch-completion jumps. Snapshot is shallow {id, status}
        // so iteration is cheap on large trackers.
        const prev = useAgentStore.getState().tasks
        const prevCompletedIds = new Set(prev.filter(t => t.status === 'completed').map(t => t.id))

        useAgentStore.getState().setTasks(tasks)

        // Persist to `<project>/.toquemedia/tasks.json` so the tracker
        // survives app restarts, budget interrupts, and chat-session
        // boundaries. The agent reading the prompt next turn sees the same
        // state regardless of zustand re-init. Fire-and-forget on the IO —
        // failures only warn; the in-memory store is still live and the
        // next mutation will retry the persist.
        const project = useProjectStore.getState().currentProject
        if (project?.path) {
          void import('./taskPersistence').then(({ saveTasksToDisk }) =>
            saveTasksToDisk(project.path, tasks),
          )
        }

        // Invalidate the prompt cache. `getTrackerStateSection` is part of
        // the dynamic block but the cache key does NOT include a tracker
        // signature — without this bump, the next turn within the 30s TTL
        // would serve a stale prompt rendering the PRE-update tracker.
        // That's exactly the failure this fix was meant to prevent. Using
        // `bumpFsVersion` (not the regex-based invalidatePromptCache path)
        // because `fsVersion` is the live key the cache reads on every
        // build — see fsVersion.ts for why it's the safer hook.
        import('../fsVersion').then(m => m.bumpFsVersion('update_tasks')).catch(() => { /* non-critical */ })

        // Plan-mode progress: a successful update_tasks after PLAN.md is the
        // signal that the architect has finished. Combined with planFileWritten
        // this trips the strict-STOP guard in execute() on any subsequent call.
        if (this.planMode && this.planFileWritten) {
          this.planTasksSeeded = true
        }

        const completed = tasks.filter(t => t.status === 'completed').length
        const newlyCompletedIds = tasks
          .filter(t => t.status === 'completed' && !prevCompletedIds.has(t.id))
          .map(t => t.id)

        // Batch-completion guard — soft warning, not a block. Returns the
        // standard success message PLUS a structured warning when more than
        // one task transitioned to completed since the previous call (and
        // it's not the seed state where prev was empty). The agent reads
        // the warning in its tool result and either confirms the jump (if
        // each task was genuinely verified in this same turn) or reverts
        // the over-claim on the next call.
        //
        // This is the exact failure mode observed in the post-budget-interrupt
        // session: 12 → 19 completed in one call, then 20 → 23 with a single
        // file write — both based on filesystem inference rather than per-task
        // verification. The warning surfaces the jump as a question, not a
        // rule violation, so legitimate sequenced work is unaffected.
        const wasSeed = prev.length === 0
        const jumpSize = newlyCompletedIds.length
        if (!wasSeed && jumpSize > 1) {
          return (
            `Task list updated: ${completed}/${tasks.length} completed.\n\n` +
            `⚠️ Batch-completion warning: ${jumpSize} tasks flipped to \`completed\` in this single call ` +
            `(IDs: ${newlyCompletedIds.join(', ')}). Each \`completed\` is a claim that THAT task's ` +
            `acceptance was verified — test passed, endpoint smoked, diff approved AND behaviour confirmed. ` +
            `If you batch-marked them by inferring "files exist → tasks done", revert the over-claim now: ` +
            `keep only the one you actually verified this turn as \`completed\`, return the rest to \`pending\`, ` +
            `and pick one to set \`in_progress\`. If every task in the batch WAS verified one-by-one earlier in ` +
            `this turn (separate tool calls per task), confirm by ignoring this warning — but the developer ` +
            `sees the warning too, so the bar is "I can defend each completion".`
          )
        }

        return `Task list updated: ${completed}/${tasks.length} completed.`
      }
    })

    // === save_memory ===
    // Persists a memory entry to `.toquemedia/memory/` (project scope) or
    // `~/.toquemedia-studio/memory/` (user scope). Writes the topic file
    // AND updates MEMORY.md so the index reflects the new entry on the
    // next prompt build. Bumps fsVersion so the in-flight prompt cache
    // invalidates and the new memory shows up the next turn.
    this.tools.set('save_memory', {
      definition: {
        name: 'save_memory',
        description:
          'Persist a long-lived memory the model should see in future turns and future sessions. Use when you learn a fact about the developer (their role, preferences), get explicit feedback ("don\'t do X" / "yes exactly, do X"), discover a project-specific decision worth keeping (initiative, deadline, ownership), or want to remember where to look up external info (Linear project, Grafana board). DO NOT save: code patterns/conventions derivable from the repo, git-blame style "who changed what", debugging recipes (the fix is in the code), or anything already in CLAUDE.md. The entry is written to disk and travels with the project (project/reference types) or the IDE installation (user/feedback types).',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Short kebab-case slug identifying this memory. Used both as the filename and to update or link the entry later. Example: "no-emojis", "rename-tm-code", "auth-proxy-pattern".',
            },
            type: {
              type: 'string',
              enum: ['user', 'feedback', 'project', 'reference'],
              description: 'Closed taxonomy: `user` (developer role/profile/skills), `feedback` (explicit correction OR validated approach, with Why + How), `project` (ongoing initiative/decision/bug context for the current project), `reference` (where to look for X in external systems).',
            },
            description: {
              type: 'string',
              description: 'One-line summary (≤150 chars) shown in MEMORY.md to decide if this memory is relevant to a future task. Be specific — "user is data scientist focused on logging observability" beats "user is a data scientist".',
            },
            body: {
              type: 'string',
              description: 'Full memory content. For `feedback` and `project` types, structure as: Lead with the rule/fact, then a `**Why:**` line (the motivation — incident or strong preference) and a `**How to apply:**` line (when/where this kicks in). For `user` and `reference` types, plain prose is fine. Use [[other-name]] to link related memories.',
            },
          },
          required: ['name', 'type', 'description', 'body'],
        },
      },
      execute: async (input) => {
        const { defaultScopeForType, memoryFilenameFor, buildMemoryFileContent, loadMemoryIndex } =
          await import('./memdir')
        const name = String(input.name || '').trim()
        const type = String(input.type || '').trim() as 'user' | 'feedback' | 'project' | 'reference'
        const description = String(input.description || '').trim()
        const body = String(input.body || '').trim()

        if (!name) return 'save_memory failed: `name` is required and cannot be empty.'
        if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
          return `save_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
        }
        if (!description) return 'save_memory failed: `description` is required (one-line summary for the index).'
        if (description.length > 200) return 'save_memory failed: `description` must be ≤200 chars (it goes on a single line in MEMORY.md).'
        if (!body) return 'save_memory failed: `body` is required (the actual memory content).'

        const scope = defaultScopeForType(type)
        const filename = memoryFilenameFor(type, name)
        const projectPath = useProjectStore.getState().currentProject?.path
        if (scope === 'project' && !projectPath) {
          return 'save_memory failed: project-scope memories require an open project. Try `type: "user"` for a cross-project fact.'
        }

        // Write the topic file first — if this fails the index isn't
        // touched, so MEMORY.md never points at a missing entry.
        try {
          await invoke('write_memory_file', {
            scope,
            projectPath: scope === 'project' ? projectPath : null,
            filename,
            content: buildMemoryFileContent({ name, type, description }, body),
          })
        } catch (err) {
          return `save_memory failed to write topic file: ${err instanceof Error ? err.message : String(err)}`
        }

        // Update MEMORY.md — read existing, replace the line for this
        // name if present, otherwise append. Keeping the index simple
        // (one line per entry) is the contract — see memdir.ts for the
        // truncation cap. Concurrent saves race; pragmatic for now since
        // saves are user-driven and rare.
        try {
          const existingIndex = await loadMemoryIndex(scope, projectPath)
          const lineToWrite = `- [${name}](${filename}) — ${description}`
          let lines = (existingIndex.content ?? '').split('\n')
          // Strip trailing truncation warning if present — preserve only the
          // actual index lines for the rewrite.
          const warningIdx = lines.findIndex(l => l.startsWith('> ⚠️ MEMORY.md'))
          if (warningIdx >= 0) lines = lines.slice(0, warningIdx).filter(l => l.length > 0)
          const headerLines = lines[0]?.startsWith('# ') ? [lines[0]] : ['# Memory Index']
          const entryLines = lines
            .slice(headerLines.length)
            .filter(l => l.trim().length > 0 && !l.includes(`(${filename})`))
          entryLines.push(lineToWrite)
          // Stable sort by name — keeps the index predictable for humans.
          entryLines.sort((a, b) => a.localeCompare(b))
          const merged = [...headerLines, '', ...entryLines, ''].join('\n')
          await invoke('write_memory_file', {
            scope,
            projectPath: scope === 'project' ? projectPath : null,
            filename: 'MEMORY.md',
            content: merged,
          })
        } catch (err) {
          // Topic file was written; index update failed. Surface it but
          // don't treat it as a fatal — next save_memory call retries the
          // index merge.
          console.warn('[save_memory] index update failed:', err)
        }

        // Invalidate caches so the next turn sees the new memory:
        //   - fsVersion bump invalidates the prompt cache (contextBuilder).
        //   - memory-selector cache clear forces a fresh relevance pass on
        //     the new catalog instead of serving a stale name list.
        import('../fsVersion').then(m => m.bumpFsVersion(`save_memory:${name}`)).catch(() => {})
        import('./memorySelector').then(m => m.invalidateMemorySelectorCache()).catch(() => {})
        // If this save corresponded to an auto-extracted proposal, mark
        // the proposal `saved` in the audit log and drop it from the
        // active working set so it doesn't re-fire on the next prompt.
        import('./memoryProposalsStore').then(m =>
          m.markProposalSaved(projectPath ?? null, name, type),
        ).catch(() => { /* noop */ })
        // Mark a write in this turn — the post-turn extractor skips its
        // pass when the agent already persisted memory, avoiding the
        // duplicate-proposal noise that's the extractor's main miss.
        import('./memoryWriteTracker').then(async (m) => {
          const { useChatStore } = await import('../../stores/chatStore')
          const sessionId = useChatStore.getState().activeSessionId
          if (sessionId) m.recordMemoryWrite(sessionId)
        }).catch(() => { /* noop */ })

        return `Memory saved: ${scope}/${filename} (${type}). It will appear in the persistent-memory section of every future prompt for this ${scope === 'project' ? 'project' : 'IDE installation'}.`
      },
    })

    // === forget_memory ===
    // Removes a memory entry. Idempotent — deleting an already-gone
    // entry returns the same success message.
    this.tools.set('forget_memory', {
      definition: {
        name: 'forget_memory',
        description: 'Remove a previously-saved memory. Use when a memory turns out to be wrong, outdated, or no longer applies (developer changed their preference, project moved off the approach, fact was learned to be incorrect). Specify the same `name` you used when saving.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The kebab-case slug used at save time.',
            },
            type: {
              type: 'string',
              enum: ['user', 'feedback', 'project', 'reference'],
              description: 'The type used at save time — needed to construct the filename. If you forget the type, list_directory the memory dir to find the right one.',
            },
          },
          required: ['name', 'type'],
        },
      },
      execute: async (input) => {
        const { defaultScopeForType, memoryFilenameFor, loadMemoryIndex } = await import('./memdir')
        const name = String(input.name || '').trim()
        const type = String(input.type || '').trim() as 'user' | 'feedback' | 'project' | 'reference'

        if (!name) return 'forget_memory failed: `name` is required.'
        if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
          return `forget_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
        }

        const scope = defaultScopeForType(type)
        const filename = memoryFilenameFor(type, name)
        const projectPath = useProjectStore.getState().currentProject?.path

        // Delete the topic file (idempotent).
        try {
          await invoke('delete_memory_file', {
            scope,
            projectPath: scope === 'project' ? projectPath : null,
            filename,
          })
        } catch (err) {
          return `forget_memory failed: ${err instanceof Error ? err.message : String(err)}`
        }

        // Strip the line from MEMORY.md.
        try {
          const existingIndex = await loadMemoryIndex(scope, projectPath)
          if (existingIndex.content) {
            let lines = existingIndex.content.split('\n')
            const warningIdx = lines.findIndex(l => l.startsWith('> ⚠️ MEMORY.md'))
            if (warningIdx >= 0) lines = lines.slice(0, warningIdx)
            const filtered = lines.filter(l => !l.includes(`(${filename})`))
            await invoke('write_memory_file', {
              scope,
              projectPath: scope === 'project' ? projectPath : null,
              filename: 'MEMORY.md',
              content: filtered.join('\n'),
            })
          }
        } catch (err) {
          console.warn('[forget_memory] index update failed:', err)
        }

        import('../fsVersion').then(m => m.bumpFsVersion(`forget_memory:${name}`)).catch(() => {})
        import('./memorySelector').then(m => m.invalidateMemorySelectorCache()).catch(() => {})
        // Count a forget as a write for the extractor-skip gate too —
        // the agent's noticing discipline (whether saving or deleting)
        // is what we want to defer to.
        import('./memoryWriteTracker').then(async (m) => {
          const { useChatStore } = await import('../../stores/chatStore')
          const sessionId = useChatStore.getState().activeSessionId
          if (sessionId) m.recordMemoryWrite(sessionId)
        }).catch(() => { /* noop */ })
        return `Memory forgotten: ${scope}/${filename}.`
      },
    })

    // === read_memory ===
    // Reads the full body of a memory entry. The system prompt injects
    // only the MEMORY.md index (one line per entry); the full body —
    // including the Why / How to apply structure — is loaded on demand
    // when the agent decides a memory's full content is relevant to the
    // current task.
    this.tools.set('read_memory', {
      definition: {
        name: 'read_memory',
        description: 'Read the full body of a memory entry referenced in MEMORY.md. The system prompt injects only the one-line summaries (the indexes); call this when you need the Why / How to apply detail behind a feedback or project entry.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The kebab-case slug from MEMORY.md.',
            },
            type: {
              type: 'string',
              enum: ['user', 'feedback', 'project', 'reference'],
              description: 'The memory type (also encoded in the filename prefix shown in MEMORY.md).',
            },
          },
          required: ['name', 'type'],
        },
      },
      execute: async (input) => {
        const { defaultScopeForType, memoryFilenameFor, loadMemoryFile } = await import('./memdir')
        const name = String(input.name || '').trim()
        const type = String(input.type || '').trim() as 'user' | 'feedback' | 'project' | 'reference'

        if (!name) return 'read_memory failed: `name` is required.'
        if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
          return `read_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
        }

        const scope = defaultScopeForType(type)
        const filename = memoryFilenameFor(type, name)
        const projectPath = useProjectStore.getState().currentProject?.path
        // Load the file and its mtime in parallel — mtime drives the age
        // warning prepended below. `loadMemoryMtimes` returns the whole
        // scope (cheap single readdir), but only this filename's entry
        // is used here.
        const { loadMemoryMtimes } = await import('./memdir')
        const { memoryAgeWarning } = await import('./memoryAge')
        const [file, mtimes] = await Promise.all([
          loadMemoryFile(scope, filename, projectPath),
          loadMemoryMtimes(scope, projectPath),
        ])
        if (!file) {
          return `Memory not found: ${scope}/${filename}. Check MEMORY.md for the current list of names + types.`
        }
        const body = file.body || `[Memory ${filename} is empty]`
        // Prepend a verbose age warning when the file is past
        // MEMORY_OLD_DAYS (1 day). The agent reads this BEFORE the body,
        // so any citation it then pulls out of the body lands with the
        // "verify identifiers" instruction fresh in context.
        const warning = memoryAgeWarning(mtimes.get(filename) ?? 0)
        return warning + body
      },
    })

    // === distill_memory ===
    // Periodic memdir hygiene — reviews ALL saved entries and proposes
    // merges, deletes, and rewrites. Returns a structured proposal list
    // for the AGENT to act on (via subsequent save_memory / forget_memory
    // calls) after the developer reviews. Never mutates memdir itself.
    this.tools.set('distill_memory', {
      definition: {
        name: 'distill_memory',
        description:
          'Review the full persistent memory (user + project scopes) and propose hygiene actions: merge near-duplicates, delete stale/superseded entries, rewrite imprecise bodies. Returns proposals for review — does NOT apply them. Use periodically when the developer asks for memory cleanup, or when you notice contradictions / duplicates while reading the catalog. After this returns, surface the proposals to the developer in plain language, get explicit approval for each one, then call `save_memory` (for merges and rewrites) or `forget_memory` (for deletes) to apply.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      execute: async () => {
        // The TS memdir layer doesn't expose a list helper today —
        // enumerating via the MEMORY.md index is enough (every saved
        // entry lives in the index by contract). A future enhancement
        // could surface the Rust `list_memory_files` command directly
        // for cases where MEMORY.md drifts from the on-disk file set.
        const [
          { distillMemories },
          { loadMemoryFile, loadMemoryIndex, parseIndexEntries, memoryFilenameFor },
        ] = await Promise.all([
          import('./memoryDistiller'),
          import('./memdir'),
        ])

        const projectPath = useProjectStore.getState().currentProject?.path

        // Load both indexes, parse entries, load each body.
        const [userIdx, projectIdx] = await Promise.all([
          loadMemoryIndex('user'),
          projectPath
            ? loadMemoryIndex('project', projectPath)
            : Promise.resolve({ content: null } as { content: string | null }),
        ])

        const userEntries = userIdx.content ? parseIndexEntries(userIdx.content) : []
        const projectEntries = projectIdx.content ? parseIndexEntries(projectIdx.content) : []

        // Load every body in parallel — small files, OK to batch.
        const files: import('./memdir').MemoryFile[] = []
        const loadOps: Promise<unknown>[] = []
        for (const e of userEntries) {
          loadOps.push(
            loadMemoryFile('user', memoryFilenameFor(e.type, e.name)).then(f => {
              if (f) files.push(f)
            }),
          )
        }
        for (const e of projectEntries) {
          loadOps.push(
            loadMemoryFile('project', memoryFilenameFor(e.type, e.name), projectPath).then(f => {
              if (f) files.push(f)
            }),
          )
        }
        await Promise.all(loadOps)

        if (files.length === 0) {
          return 'No memories saved yet — nothing to distill. Run `save_memory` first when you learn facts worth persisting; come back here once the catalog has accumulated.'
        }

        if (files.length < 8) {
          return `Only ${files.length} memory entries exist — too few to meaningfully distill. Distillation pays off once the catalog has 8+ entries with overlap. Skipping for now.`
        }

        const result = await distillMemories({ files })
        if (!result) {
          return 'Distillation failed (network / side-car model unavailable). Try again later — the memdir is unchanged.'
        }

        // Telemetry — measure distiller yield over time.
        void import('../../services/analytics').then(({ trackEvent }) =>
          trackEvent('memory_distiller_run', {
            input_files: files.length,
            input_bytes: result.inputBytes,
            input_truncated: result.inputTruncated,
            proposals: result.proposals.length,
            latency_ms: result.latencyMs,
          }),
        ).catch(() => { /* noop */ })

        if (result.proposals.length === 0) {
          return `Distilled ${files.length} memory entries — no hygiene actions needed. The catalog looks clean (no obvious duplicates, contradictions, or stale entries).`
        }

        // Format proposals for the agent to surface to the developer.
        const lines: string[] = [
          `Distilled ${files.length} memory entries — ${result.proposals.length} hygiene proposal${result.proposals.length === 1 ? '' : 's'} below.`,
          '',
          'Review each with the developer, get explicit approval, then apply:',
          '- **merge** / **rewrite** → call `save_memory(name, type, description, body)` with the proposed name/description/body. Then `forget_memory` any obsolete original names.',
          '- **delete** → call `forget_memory(name, type)` for each target.',
          '',
          '---',
          '',
        ]
        for (const [i, p] of result.proposals.entries()) {
          lines.push(`### Proposal ${i + 1}: \`${p.action}\``)
          lines.push(`**Targets:** ${p.targets.map(t => `\`${t}\``).join(', ')}`)
          lines.push(`**Why:** ${p.rationale}`)
          if (p.action !== 'delete') {
            lines.push(`**Proposed name:** \`${p.newName ?? p.targets[0]}\``)
            lines.push(`**Proposed description:** ${p.newDescription ?? ''}`)
            lines.push('**Proposed body:**')
            lines.push('```')
            lines.push(p.newBody ?? '')
            lines.push('```')
          }
          lines.push('')
        }
        if (result.inputTruncated) {
          lines.push(`> Note: the input was truncated to fit the model's window. Re-run distill_memory after applying a first batch — the remaining entries will be considered next time.`)
        }
        return lines.join('\n')
      },
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

    // === provision_database ===
    // Reserves a per-app SQLite/libSQL database on the platform's Turso fleet
    // and writes the two credentials user code needs (`TMDB_URL` +
    // `TMDB_TOKEN`) to .env. The Turso platform token and the database's
    // own JWT stay on the TM Code Worker — user code only sees the
    // app-scoped TMDB token, which the worker validates per request.
    //
    // The endpoint is idempotent (worker reuses an existing record when
    // present), so re-running on an already-provisioned project just
    // returns the existing credentials. Same shape as provision_auth.
    this.tools.set('provision_database', {
      definition: {
        name: 'provision_database',
        description:
          "Set up TM Code Database (per-app SQLite/libSQL on Turso) for the current project. Reserves the app's database on the platform, mints an app-scoped TMDB token, and writes TMDB_URL + TMDB_TOKEN to .env. The Turso platform token and per-DB JWT stay on the TM Code Worker — user code talks to the worker via HTTPS using the TMDB_TOKEN. Call when the project needs persistence in production (an auth user record, app state, anything that must survive container restarts). Local dev alone does not need this — db.ts can stay on `DATABASE_URL=file:./dev.db`. The endpoint is fully idempotent: calling on an already-provisioned project returns the same credentials with zero side-effect, so call it whenever the .env mechanical check (look for TMDB_URL and TMDB_TOKEN) shows either is missing — including after a transient failure where you're retrying. After a successful return, generate `server/db.ts` with the dev/prod connection switch from read_skill(\"publish-backend\") and `server/schema.ts` for Drizzle.",
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      execute: async () => {
        const project = useProjectStore.getState().currentProject
        if (!project) {
          return 'No project is open. Open a project before provisioning the database.'
        }

        const firebaseAuth = FirebaseAuthService.getInstance()
        const idToken = await firebaseAuth.getIdToken()
        if (!idToken) {
          return 'Not authenticated to TM Code. Sign in first, then retry.'
        }

        const workerUrl = resolveWorkerUrl()
        let provisionRes: Awaited<ReturnType<typeof tauriFetch>>
        try {
          provisionRes = await tauriFetch(
            `${workerUrl}/v1/apps/${encodeURIComponent(project.id)}/database/provision`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`,
              },
              body: JSON.stringify({}),
            },
          )
        } catch (err) {
          // Same hard-stop posture as provision_auth: network failure must
          // not become "let me ask the developer for the DB URL", because
          // the developer doesn't own those credentials. Wait for the user.
          return (
            `PROVISION_DATABASE FAILED — STOP DATA-LAYER WORK.\n\n` +
            `Network error reaching the database provisioning endpoint: ${err instanceof Error ? err.message : String(err)}\n\n` +
            `Do NOT fall back to request_credentials for TMDB_URL, TMDB_TOKEN, DATABASE_URL — those credentials are minted by the platform and do not exist until provision_database succeeds.\n\n` +
            `Required recovery: report the network error to the developer in chat, suggest checking their connection, and wait for them to decide whether to retry. Do not auto-retry.`
          )
        }

        if (!provisionRes.ok) {
          const body = await provisionRes.text().catch(() => '')
          return (
            `PROVISION_DATABASE FAILED — STOP DATA-LAYER WORK.\n\n` +
            `Error from worker (HTTP ${provisionRes.status}): ${body.slice(0, 300)}\n\n` +
            `What this means: the platform could not provision a per-app database. ` +
            `Without it, TMDB_URL / TMDB_TOKEN do not exist and production persistence cannot be wired up.\n\n` +
            `Wrong recovery paths (DO NOT TAKE):\n` +
            `  ✗ request_credentials for TMDB_URL / TMDB_TOKEN / DATABASE_URL — the developer does not own these.\n` +
            `  ✗ swap to a different ORM/driver hoping it bypasses the platform — the harness rejects Prisma, mysql2, pg, sqlite3, better-sqlite3 on write to package.json.\n\n` +
            `Required recovery:\n` +
            `  1. STOP the data-layer task. Do not write db.ts / schema.ts / migrations.\n` +
            `  2. Tell the developer what happened — quote the error above verbatim.\n` +
            `  3. If the error says "group not found" / "HTTP 400" / "Turso ..." (any platform-side rejection): ask the developer to share the line that starts with \`[turso] createDatabase:\` from the TM Code Worker logs (\`wrangler tail\` or the dev terminal). That line shows the org + group + db-name the worker actually sent, which pinpoints whether it's a config issue (wrong group), a stale build (wrangler dev not restarted), or a true upstream outage.\n` +
            `  4. Suggest one of: (a) retry provision_database in a new chat turn if transient, (b) report to TM Code support if it persists, (c) keep persistence local-dev-only by using DATABASE_URL=file:./dev.db without the prod branch.\n` +
            `  5. Wait for the developer's decision. Do not auto-retry.`
          )
        }

        const data = (await provisionRes.json()) as {
          tmdbUrl?: string
          tmdbToken?: string
          dbName?: string
          reused?: boolean
        }

        if (!data.tmdbUrl || !data.tmdbToken || !data.dbName) {
          return `Provisioning returned incomplete data: ${JSON.stringify(data)}`
        }

        const envVars: Array<{ key: string; value: string }> = [
          { key: 'TMDB_URL', value: data.tmdbUrl },
          { key: 'TMDB_TOKEN', value: data.tmdbToken },
        ]

        try {
          await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
        } catch (err) {
          return `Database provisioned (${data.dbName}) but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
        }

        const reusedSuffix = data.reused ? ' (reused existing)' : ''
        const lines: string[] = []
        lines.push(`Database ready: ${data.dbName}${reusedSuffix}.`)
        lines.push(`.env written: TMDB_URL, TMDB_TOKEN.`)
        lines.push('')
        lines.push('## Database contract (do not improvise)')
        lines.push('')
        lines.push('### Connection switch (server/db.ts)')
        lines.push('  - Dev (`NODE_ENV !== "production"`): `drizzle-orm/libsql/node` with `createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" })`.')
        lines.push('  - Prod (`NODE_ENV === "production"`): `drizzle-orm/sqlite-proxy` driver, forwarding queries to `${TMDB_URL}` over HTTPS with `Authorization: Bearer ${TMDB_TOKEN}`. The worker accepts `POST { sql, params, method }` for single queries and `POST { batch: [...] }` for transactions.')
        lines.push('  - The user code MUST NOT import `@libsql/client` directly in production — the worker is the only path to Turso. Direct libsql connections from Cloud Run will fail (no platform token in user env).')
        lines.push('')
        lines.push('### Schema (server/schema.ts)')
        lines.push('  - Drizzle table definitions in TypeScript. Add `index().on(field)` for query hot paths.')
        lines.push('  - Generate migrations with `drizzle-kit generate --config=drizzle.config.ts` after schema changes.')
        lines.push('  - The deploy pipeline reapplies migration SQL against the app\'s TMDB on publish. Local dev runs `drizzle-kit push` or `drizzle-kit migrate` against the file:./dev.db, never against TMDB.')
        lines.push('')
        lines.push('### Forbidden')
        lines.push('  - `@prisma/client`, `prisma`, `better-sqlite3`, `sqlite3`, `mysql2`, `pg` — the write_file harness rejects these on package.json edits. The reason: Prisma needs a persistent connection (incompatible with Cloud Run scale-to-zero + worker HTTPS proxy); native-bound SQLite drivers and non-SQLite dialects don\'t round-trip through the worker.')
        lines.push('  - Hard-coding TMDB_URL or TMDB_TOKEN in any committed file. They live ONLY in .env.')
        lines.push('')
        lines.push('### Next steps')
        lines.push('  1. read_skill("publish-backend") for the full db.ts template + sqlite-proxy fetcher.')
        lines.push('  2. Write server/schema.ts with the tables you need (start small — add columns later).')
        lines.push('  3. Write server/db.ts using the dev/prod switch from the skill.')
        lines.push('  4. Generate the first migration with drizzle-kit.')

        return lines.join('\n')
      },
    })

    // === provision_files ===
    // Reserves the per-app file storage credentials on the platform and
    // writes TM_FILES_URL / TM_FILES_TOKEN / TM_FILES_PUBLIC_BASE to .env.
    //
    // Storage layout on R2: `{slug}/_files/{userKey}`. Reads are served
    // directly by the slug's subdomain (`https://{slug}.toquemedia.net/_files/key`)
    // — no Worker hop, no CORS for same-origin frontend fetches. Writes
    // go through this Worker (PUT /v1/apps/{appId}/files/{key}) with
    // TM_FILES_TOKEN as a bearer.
    //
    // Same idempotency semantics as provision_database / provision_auth:
    // second call reuses the existing record.
    this.tools.set('provision_files', {
      definition: {
        name: 'provision_files',
        description:
          "Set up TM Code File Storage (per-app R2 prefix) for the current project. Reserves the app's storage slot on the platform, mints a TM_FILES_TOKEN, and writes TM_FILES_URL + TM_FILES_TOKEN + TM_FILES_PUBLIC_BASE to .env. Use ONCE when the project needs to handle user uploads (avatars, images, attachments, documents) in production. **Required before writing any upload route** — the alternative (base64 in DB) is forbidden by the publish-backend skill: it bloats the DB, kills query latency, and has no CDN. After provisioning, generate the files helper from read_skill(\"publish-backend\") §9.5 at `backend/src/files.ts` (or `server/src/files.ts` if the project uses the `server/` layout — the deploy bundle detects either). Call uploadFile() from your upload routes. Idempotent: second call returns the same credentials.",
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      execute: async () => {
        const project = useProjectStore.getState().currentProject
        if (!project) {
          return 'No project is open. Open a project before provisioning file storage.'
        }

        const firebaseAuth = FirebaseAuthService.getInstance()
        const idToken = await firebaseAuth.getIdToken()
        if (!idToken) {
          return 'Not authenticated to TM Code. Sign in first, then retry.'
        }

        // Compute a candidate slug from the project name. The worker accepts
        // this as a fallback when no deploy record exists yet — most agent
        // calls to provision_files happen pre-publish (during scaffolding of
        // upload routes), so the deploy record doesn't exist. After the first
        // publish, the worker will pin to the actual deploy slug regardless
        // of what we send here.
        const candidateSlug = project.name
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 63) || project.id.slice(0, 32)

        const workerUrl = resolveWorkerUrl()
        let provisionRes: Awaited<ReturnType<typeof tauriFetch>>
        try {
          provisionRes = await tauriFetch(
            `${workerUrl}/v1/apps/${encodeURIComponent(project.id)}/files/provision`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`,
              },
              body: JSON.stringify({ slug: candidateSlug }),
            },
          )
        } catch (err) {
          return (
            `PROVISION_FILES FAILED — STOP UPLOAD-RELATED WORK.\n\n` +
            `Network error reaching the file storage provisioning endpoint: ${err instanceof Error ? err.message : String(err)}\n\n` +
            `Do NOT fall back to base64-in-DB or to request_credentials for TM_FILES_URL/TM_FILES_TOKEN — those credentials are minted by the platform and don't exist until provision_files succeeds.\n\n` +
            `Required recovery: report the network error to the developer, suggest checking their connection, and wait for them to decide whether to retry. Do not auto-retry.`
          )
        }

        if (!provisionRes.ok) {
          const body = await provisionRes.text().catch(() => '')
          return (
            `PROVISION_FILES FAILED — STOP UPLOAD-RELATED WORK.\n\n` +
            `Error from worker (HTTP ${provisionRes.status}): ${body.slice(0, 300)}\n\n` +
            `Wrong recovery paths (DO NOT TAKE):\n` +
            `  ✗ base64-in-DB — bloats the DB, kills query latency. Forbidden by publish-backend skill §9.5.\n` +
            `  ✗ request_credentials for TM_FILES_URL / TM_FILES_TOKEN — the developer does not own these.\n` +
            `  ✗ switch to S3/Firebase Storage — only valid as an explicit user choice, not a silent fallback.\n\n` +
            `Required recovery:\n` +
            `  1. STOP the upload route work. Do not write files.ts or upload handlers.\n` +
            `  2. Tell the developer what happened — quote the error above verbatim.\n` +
            `  3. Suggest one of: (a) retry provision_files in a new chat turn if transient, (b) report to TM Code support if it persists.\n` +
            `  4. Wait for the developer's decision. Do not auto-retry.`
          )
        }

        const data = (await provisionRes.json()) as {
          url?: string
          token?: string
          publicBase?: string
          reused?: boolean
        }

        if (!data.url || !data.token || !data.publicBase) {
          return `Provisioning returned incomplete data: ${JSON.stringify(data)}`
        }

        const envVars: Array<{ key: string; value: string }> = [
          { key: 'TM_FILES_URL', value: data.url },
          { key: 'TM_FILES_TOKEN', value: data.token },
          { key: 'TM_FILES_PUBLIC_BASE', value: data.publicBase },
        ]

        try {
          await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
        } catch (err) {
          return `File storage provisioned but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
        }

        const reusedSuffix = data.reused ? ' (reused existing)' : ''
        const lines: string[] = []
        lines.push(`File storage ready${reusedSuffix}.`)
        lines.push(`.env written: TM_FILES_URL, TM_FILES_TOKEN, TM_FILES_PUBLIC_BASE.`)
        lines.push('')
        lines.push('## Storage contract (do not improvise)')
        lines.push('')
        lines.push('### Write path (server/files.ts)')
        lines.push('  - PUT to `${TM_FILES_URL}/{key}` with `Authorization: Bearer ${TM_FILES_TOKEN}` and the file body as the request body.')
        lines.push('  - Response: `{ publicUrl, key, size, contentType }`. Store the `publicUrl` in your DB row — never the bytes themselves.')
        lines.push('  - Max 10 MB per upload. The Worker enforces this — your route should also pre-validate to reject early.')
        lines.push('  - Keys allow nested paths (`posts/cover.jpg`). Forbidden: `..`, leading `/`, control chars.')
        lines.push('')
        lines.push('### Read path')
        lines.push('  - Public URL is `${TM_FILES_PUBLIC_BASE}/_files/{key}` — same origin as your frontend, no CORS. Cloudflare serves it directly from R2, zero Worker invocations on the read path.')
        lines.push('  - Embed in `<img src=...>` / `<video src=...>` etc. with normal browser caching.')
        lines.push('')
        lines.push('### Delete path')
        lines.push('  - DELETE on `${TM_FILES_URL}/{key}` with the same bearer. Returns `{ deleted: key }`.')
        lines.push('  - When the app itself is deleted, the platform cleans up the whole prefix — you do not need to delete files manually unless the user explicitly removes them.')
        lines.push('')
        lines.push('### Forbidden')
        lines.push('  - base64-in-DB columns (`avatarData`, `imageBase64`, `dataUrl: "data:image/..."`). Use the publicUrl returned by the upload instead.')
        lines.push('  - Storing TM_FILES_TOKEN anywhere in committed code. It lives ONLY in .env.')
        lines.push('  - Direct R2 SDK calls (`@aws-sdk/client-s3`, `wrangler-r2`) — the Worker is the only authorized write path.')
        lines.push('')
        lines.push('### Next steps')
        lines.push('  1. read_skill("publish-backend") §9.5 for the full files.ts helper.')
        lines.push('  2. Write `backend/src/files.ts` exporting `uploadFile(key, body, contentType)` and `deleteFile(key)`.')
        lines.push('  3. Wire upload routes that accept multipart/form-data, validate type+size, then call uploadFile.')
        lines.push('  4. Store the returned publicUrl in the relevant DB row.')

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
          'Request API keys, tokens, or other secrets from the developer via a secure form rendered inline in the chat. The form writes the values directly into the project .env (which is otherwise unreadable and unwritable by the agent). Never instruct the developer to create or edit .env manually, and never ask them to paste secrets into the chat.\n\nUSE FOR: third-party services the developer is integrating into their app (OpenAI, Anthropic, Stripe, SendGrid, Twilio, Resend, generic webhooks, etc.).\n\nSKIP FOR: platform-managed credentials. The platform mints these via dedicated provision_* tools — the developer doesn\'t have the values and never will. Mapping: TM_AUTH_*/VITE_TM_*/GIP_*/GCP_* → provision_auth; TMDB_URL/TMDB_TOKEN/DATABASE_URL → provision_database; TM_FILES_URL/TM_FILES_TOKEN/TM_FILES_PUBLIC_BASE → provision_files; APP_ID → provision_deploy. Calling this form for any of those is incorrect.',
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
            // Buffered variants — sub-agent SSE bumps streamingVersion at
            // the same 50ms cadence as the parent agent loop. Without the
            // swap, every sub-agent token was a fresh re-render of the
            // streaming bubble even though the parent had already batched
            // its own.
            appendTextDelta: appendTextDeltaBuffered,
            appendReasoningDelta: appendReasoningDeltaBuffered,
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
