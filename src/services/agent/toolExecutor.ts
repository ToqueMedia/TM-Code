import { invoke } from '@/utils/invokeMetrics'
import { listen } from '@tauri-apps/api/event'
import { t } from '@/i18n'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useProjectStore } from '../../stores/projectStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import FirebaseAuthService, { getAppCheckHeader } from '../auth/firebaseAuth'
import { registerTaskTools } from './toolExecutor/taskOps'
import { registerMemoryTools } from './toolExecutor/memoryOps'
import { registerInteractionTools } from './toolExecutor/interactionOps'
import { registerProvisionTools } from './toolExecutor/provisionOps'
import type { ToolRegistrationContext } from './toolExecutor/context'
import {
  isEnvFile,
  isSensitiveFile,
  simpleHash,
  matchDangerousCommand,
  matchStateMutatingCommand,
  WRITE_COMMAND_PATTERNS,
  DANGEROUS_COMMANDS,
  STATE_MUTATING_COMMANDS,
  normalizePath,
  checkForbiddenAuthImports,
  checkForbiddenItkV2,
  checkForbiddenServiceAccountImport,
  checkForbiddenDataLayerDeps,
  checkForbiddenDockerfileShape,
} from './toolExecutor/checks'
import { tauriFetch } from '../tauriFetch'
import { devServerManager } from '../devServerManager'
import { resolveWorkerUrl } from '../../utils/devUrls'
import { formatError } from '../../utils/errors'
import { checkPlanModeAccess, isPlanArtefactAtRoot } from './planMode'
import { READ_FILE, WRITE_FILE, EDIT_FILE } from './toolNames'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from './toolExecutor/fileStateCache'
import { checkReadDedup } from './toolExecutor/readDedup'
import { getSnippetForTwoFileDiff } from './toolExecutor/changedFileSnippet'
import { extractReadFilesFromMessages } from './toolExecutor/readStateRecovery'
import { getFsVersion, bumpFsVersion } from '../fsVersion'
import CheckpointService from './checkpointService'
import type { MCPTool } from '../mcp/mcpService'
import type { AgentCallbacks } from './types'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, hasPendingDiffApprovals } from '../../stores/chatStore'
import { useAskUserQuestionStore } from '../../stores/askUserQuestionStore'
import { useCredentialRequestStore } from '../../stores/credentialRequestStore'

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

interface AgentShellSession {
  id: string
  cwd: string
  output: string
  readOffset: number
  activeToolCallId: string | null
  exited: boolean
  exitCode: number | null
  createdAt: number
  updatedAt: number
}

interface PtyOutputEvent {
  session_id: string
  data: string
}

interface PtyExitEvent {
  session_id: string
  exit_code: number
}

interface InteractiveShellInfo {
  command: string
  args: string[]
  kind: string
  commandStyle: string
  platform: string
  warning?: string | null
}

const AGENT_SHELL_MAX_BUFFER_CHARS = 200_000

// === Abort helpers ===

/**
 * Create a child AbortController linked to an optional parent signal.
 * When the parent fires, the child fires too. If the parent is already
 * aborted at call time, the child is aborted immediately.
 *
 * Used by sub-agents to propagate
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

/**
 * Detect commands whose output should stream in real-time to the UI.
 * These are long-running commands (build, test, lint, script execution)
 * where the user benefits from seeing live logs instead of waiting for
 * the final result.
 *
 * Install commands (npm install, etc.) are handled separately by
 * `executeInstallStreaming` which has additional PID-based cancellation.
 */
function isStreamingCommand(cmd: string): boolean {
  const normalized = cmd.replace(/\s+/g, ' ').trim()

  // Shell scripts (.sh, .bash)
  if (/\.(?:sh|bash)(?:\s|$)/.test(normalized)) return true
  if (/\bbash\b/.test(normalized) && /\.sh/.test(normalized)) return true

  // Build commands
  if (/(?:npm|yarn|pnpm|bun)\s+run\s+(?:build|compile|dist|package|bundle)/.test(normalized)) return true
  if (/\b(?:make|cmake|gradle|mvn|cargo\s+build|go\s+build)\b/.test(normalized)) return true
  if (/\bwebpack\b|\bvite\s+build\b|\brollup\b|\besbuild\b/.test(normalized)) return true

  // Test commands
  if (/(?:npm|yarn|pnpm|bun)\s+run\s+(?:test|test:\w+|spec|e2e)/.test(normalized)) return true
  if (/(?:npm|yarn|pnpm|bun)\s+test\b/.test(normalized)) return true
  if (/\bjest\b|\bvitest\b|\bmocha\b|\bcypress\b|\bplaywright\b/.test(normalized)) return true
  if (/\bcargo\s+test\b|\bgo\s+test\b|\bpytest\b/.test(normalized)) return true

  // Lint / format commands
  if (/(?:npm|yarn|pnpm|bun)\s+run\s+(?:lint|format|check|typecheck)/.test(normalized)) return true
  if (/\btsc\b|\beslint\b|\bprettier\b/.test(normalized)) return true
  if (/\bflake8\b|\bruff\b|\bblack\b/.test(normalized)) return true

  // Compound commands with && that include streaming-capable parts
  if (/&&/.test(normalized)) {
    const parts = normalized.split('&&').map(p => p.trim())
    if (parts.some(p => isStreamingCommand(p))) return true
  }

  return false
}

function formatBackgroundCommandResult(cmd: {
  id: string; command: string; status: string; pid: number;
  exitCode: number | null; output: string; startedAt: number; completedAt: number | null
}): string {
  const elapsed = cmd.completedAt
    ? `${Math.round((cmd.completedAt - cmd.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - cmd.startedAt) / 1000)}s (still running)`

  const lines: string[] = [
    `[${cmd.status.toUpperCase()}] ${cmd.command} (id: ${cmd.id}, PID: ${cmd.pid}, elapsed: ${elapsed})`,
  ]

  if (cmd.exitCode !== null) {
    lines.push(`Exit code: ${cmd.exitCode}`)
  }

  if (cmd.output) {
    const MAX_OUTPUT = 4000
    const output = cmd.output.length > MAX_OUTPUT
      ? `...(truncated)\n${cmd.output.slice(-MAX_OUTPUT)}`
      : cmd.output
    lines.push(output)
  }

  return lines.join('\n')
}

class ToolExecutor {
  private static instance: ToolExecutor
  private tools: Map<string, ToolEntry> = new Map()
  /** Tracks when files were last read by the model — for read-before-write enforcement.
   *  Stores timestamp + a simple content hash to detect concurrent modifications. */
  private readFileTimestamps: Map<string, { timestamp: number; hash: number }> = new Map()
  /** Content cache for files read by the model — enables dedup (avoids
   *  re-sending identical content) and state recovery after session resume.
   *  Mirrors claude-vaz's `FileStateCache` / `readFileState`. */
  private readFileState: FileStateCache = createFileStateCacheWithSizeLimit()
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
  private planModePlanFileName: string = 'PLAN.md'

  /**
   * Memory scope — set per-invocation by execute() when a sub-agent
   * passes its agentType. Memory tools read from execInput._memoryScope
   * (via getMemoryScope(input) helper in memoryOps.ts), which is set
   * from this field at the start of each execute() call.
   * No shared mutable state between concurrent sub-agents.
   */
  private memoryScopeAgentType: string | null = null

  /**
   * Plan-mode progress flags. Together they enforce the architect contract:
   *
   *   1. update_tasks is BLOCKED until the plan file is written (no task list without a plan).
   *   2. After both the plan file is written AND update_tasks has run once, ANY further
   *      tool call is blocked — the architect's role is complete and continuing
   *      drifts into implementation.
   *
   * Both reset to false on every enablePlanMode() so each /plan run starts clean.
   */
  private planFileWritten: boolean = false
  private planTasksSeeded: boolean = false
  private agentShellSessions: Map<string, AgentShellSession> = new Map()
  private agentShellListenersReady: Promise<void> | null = null
  private lastAgentShellSessionId: string | null = null

  /** Shared context — passed to domain registration functions. */
  private readonly ctx: ToolRegistrationContext

  /** Home dir cache para expandir `~/...` em resolveToAbsolute (que é sync).
   *  Populado fire-and-forget no arranque; até resolver, paths com `~` caem
   *  no comportamento antigo (tratados como relativos). */
  private homeDir: string | null = null

  private constructor() {
    this.ctx = this.buildContext()
    this.registerTools()
    void invoke<string>('get_home_directory')
      .then((home) => { this.homeDir = home })
      .catch(() => { /* sem home dir, `~` não expande — não é fatal */ })
  }

  static getInstance(): ToolExecutor {
    if (!ToolExecutor.instance) {
      ToolExecutor.instance = new ToolExecutor()
    }
    return ToolExecutor.instance
  }

  /**
   * Create an isolated executor for a sub-agent run.
   *
   * The child gets its own read-file cache, large-result store, shell sessions,
   * and memory scope state, while inheriting the parent execution mode. This
   * mirrors the claude-vaz pattern of per-agent tool contexts without changing
   * the main-agent singleton contract.
   */
  createIsolatedChild(): ToolExecutor {
    const child = new ToolExecutor()
    child.cmdModeCwd = this.cmdModeCwd
    child.planMode = this.planMode
    child.planModePlanFileName = this.planModePlanFileName
    child.planFileWritten = this.planFileWritten
    child.planTasksSeeded = this.planTasksSeeded
    child.largeResultsDir = this.largeResultsDir
    return child
  }

  /** Release session-scoped state owned by an isolated child executor. */
  disposeIsolatedChild(): void {
    this.resetSessionState()
    this.cmdModeCwd = null
    this.disablePlanMode()
    this.largeResultsDir = null
    this.memoryScopeAgentType = null
  }

  /** Enable CLI/CMD mode: file ops write directly to disk, no project required. */
  enableCmdMode(cwd: string): void {
    this.cmdModeCwd = cwd
  }

  private buildContext(): ToolRegistrationContext {
    return {
      tools: this.tools,
      getProjectRoot: () => this.getProjectRoot(),
      validatePathWithinProject: (p: string) => { this.validatePathWithinProject(p); return p },
      readFileTimestamps: this.readFileTimestamps,
      readFileState: this.readFileState,
      largeResults: this.largeResults,
      readLargeResultFromDisk: (id) => this.readLargeResultFromDisk(id),
      getCmdModeCwd: () => this.cmdModeCwd,
      getMemoryScopeAgentType: () => this.memoryScopeAgentType,
      getPlanMode: () => this.planMode,
      getPlanFileWritten: () => this.planFileWritten,
      setPlanTasksSeeded: (v: boolean) => { this.planTasksSeeded = v },
      truncateResult: (r, maxChars) => this.truncateResult(r, maxChars),
      trackShownRange: (id, o, e) => this.trackShownRange(id, o, e),
      simpleHash: (s) => simpleHash(s),
      formatFileTreeCompact: (n, indent) => this.formatFileTreeCompact(n, indent),
      refreshFileTree: () => this.refreshFileTree(),
      closeEditorIfOpen: (p) => this.closeEditorIfOpen(p),
      suggestSimilarPath: async (p: string) => this.suggestSimilarPath(p),
    }
  }

  /** Disable CLI/CMD mode and return to IDE diff mode. */
  disableCmdMode(): void {
    this.cmdModeCwd = null
  }

  /** Enable architect mode for /plan: implementation tools are blocked.
   *  Resets plan-progress flags so each /plan run starts clean. */
  enablePlanMode(planFileName: string = 'PLAN.md'): void {
    this.planMode = true
    this.planModePlanFileName = planFileName || 'PLAN.md'
    this.planFileWritten = false
    this.planTasksSeeded = false
  }

  /** Restore the normal coding agent surface. */
  disablePlanMode(): void {
    this.planMode = false
    this.planModePlanFileName = 'PLAN.md'
    this.planFileWritten = false
    this.planTasksSeeded = false
  }

  isPlanMode(): boolean {
    return this.planMode
  }

  /** Clears session-scoped state. Call on new sessions. */
  resetSessionState(): void {
    this.readFileTimestamps.clear()
    this.readFileState.clear()
    this.largeResults.clear()
    this.largeResultsTotalBytes = 0
    this.largeResultRangesShown.clear()
    this.largeResultCounter = 0
    this.readOnlyContexts.clear()
    for (const id of this.agentShellSessions.keys()) {
      invoke('kill_pty_session', { sessionId: id }).catch(() => {})
    }
    this.agentShellSessions.clear()
    this.lastAgentShellSessionId = null
  }

  /**
   * Rebuild read state from conversation history (session resume).
   *
   * When a session is resumed, the ToolExecutor's in-memory state is empty.
   * This method walks the conversation history and reconstructs both
   * `readFileTimestamps` and `readFileState` so that:
   *   - Read-before-write enforcement works (the model "remembers" what
   *     it has read)
   *   - Dedup works (redundant reads return stubs instead of full content)
   *
   * Mirrors claude-vaz's `extractReadFilesFromMessages`.
   *
   * @param messages  Conversation history
   * @param invokeReadFile  Tauri IPC function to read files from disk
   */
  rebuildReadStateFromHistory(
    messages: Parameters<typeof extractReadFilesFromMessages>[0],
    invokeReadFile: (path: string) => Promise<string>,
  ): void {
    const cwd = this.getProjectRoot()
    extractReadFilesFromMessages(
      messages,
      this.readFileState,
      this.readFileTimestamps,
      cwd,
      invokeReadFile,
    )
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

  // ══════════════════════════════════════════════════════════════
  // @-mention surface — used exclusively by atMentions.ts
  // ══════════════════════════════════════════════════════════════
  //
  // Mirrors claude-vaz's at-mention pipeline (utils/attachments.ts
  // `processAtMentionedFiles` → `generateFileAttachment`), which executes
  // the REAL FileReadTool for mentioned files so the model-visible result,
  // the read-state bookkeeping, and the dedup behaviour are byte-identical
  // to a model-initiated call. The permission layer is skipped on purpose:
  // the user explicitly named the target in their prompt (claude-vaz only
  // checks deny rules — `isFileReadDenied` — for at-mentions). The hard
  // blocks survive: `.env` is refused here, and path-scope validation
  // throws inside the tool handlers themselves.

  /**
   * Resolve a mention token to the absolute path the read tools will use.
   * Exposed so atMentions.ts renders the synthetic "Called the read_file
   * tool with the following input" line with the SAME path the tool call
   * actually received — claude-vaz shows the expanded absolute path too.
   */
  resolveMentionPath(p: string): string {
    return this.resolveToAbsolute(p)
  }

  /** Whether a mentioned path is inside the agent's allowed scope.
   *  Out-of-scope mentions are dropped silently — same outcome as
   *  claude-vaz's deny-rule check returning null. */
  isMentionPathAllowed(p: string): boolean {
    try {
      this.validatePathWithinProject(p)
      return true
    } catch {
      return false
    }
  }

  /**
   * Whether the model already has a fresh FULL view of this file in context.
   * Maps claude-vaz's `already_read_file` check (attachments.ts:3077-3120 —
   * entry timestamp matches the file mtime exactly): when true, the mention
   * renders to NOTHING because re-sending the content would only burn
   * cache_creation tokens. TM Code's freshness primitive is `fsVersion`
   * (no cheap per-file stat over Tauri IPC): offset === undefined means the
   * entry holds the whole file (full read, write_file or edit_file), and an
   * unchanged global fsVersion guarantees no tool writes happened since.
   * Conservative like the read dedup: external edits bump nothing, but the
   * external-change sweep (`collectExternallyChangedFiles`) covers that side.
   */
  isFileFreshInContext(filePath: string): boolean {
    const abs = this.resolveToAbsolute(filePath)
    const entry = this.readFileState.get(abs)
    return !!entry && entry.offset === undefined && entry.fsVersion === getFsVersion()
  }

  /**
   * Execute a read-only tool handler directly for @-mention resolution,
   * bypassing the permission/abort/plan-mode layers of `execute()` (the
   * mention is user-initiated; there is no model tool_call to gate).
   * Path-scope validation still throws inside the handlers; `.env` stays
   * hard-blocked here exactly as in `execute()`.
   */
  async executeForMention(
    toolName: 'read_file' | 'list_directory',
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(toolName)
    if (!tool) throw new Error(`Unknown tool: ${toolName}`)
    const filePath = (input.file_path || '') as string
    if (this.isEnvFile(filePath)) {
      // Same hard block as execute() — thrown (not returned) so the mention
      // resolver drops the mention silently instead of inlining the refusal.
      throw new Error('.env files are blocked from mention resolution')
    }
    // Ficheiros sensíveis (credentials, chaves, etc.) PERGUNTAM mesmo em
    // menção (decisão do user 2026-06-11): @credentials.json sem prompt
    // relaxava a proteção que o read_file normal tem. Negado → throw → a
    // menção é descartada silenciosamente (o user acabou de decidir isso
    // no diálogo; nenhum conteúdo chega ao modelo).
    if (toolName === 'read_file' && this.isSensitiveFile(filePath)) {
      const decision = await usePermissionStore.getState().requestPermission(
        'read_file', input, 'sensitive_file',
      )
      if (!decision.approved) {
        throw new Error('sensitive-file mention denied by user')
      }
    }
    return tool.execute(input)
  }

  /**
   * External-modification sweep — port of claude-vaz's `getChangedFiles`
   * (utils/attachments.ts:2063-2140). Walks every full-view entry in
   * `readFileState`, stats the file, and when the disk content diverged
   * from what the model last saw, returns a post-edit snippet (changed
   * hunks, line-numbered) for the "Note: X was modified..." reminder.
   *
   * State is updated in place on detection (claude-vaz re-runs
   * FileReadTool.call, which refreshes readFileState) so:
   *   - the next sweep doesn't re-fire for the same edit, and
   *   - read-before-write enforcement accepts an edit_file without a
   *     fresh read — the model HAS the current content via the snippet.
   *
   * Ranged reads (offset set) are skipped — claude-vaz has the same TODO
   * (offset/limit entries return null). Partial injected views are skipped
   * too: there is no full baseline to diff against.
   */
  async collectExternallyChangedFiles(): Promise<Array<{ path: string; snippet: string }>> {
    const changed: Array<{ path: string; snippet: string }> = []
    // Snapshot first — set() during LRU iteration would mutate recency order.
    const entries = Array.from(this.readFileState.entries())
    for (const [path, entry] of entries) {
      if (entry.offset !== undefined || entry.limit !== undefined) continue
      if (entry.isPartialView) continue

      // Cheap mtime gate before paying for a full read. stat failure means
      // deleted/unreadable — skip (claude-vaz returns null on read failure).
      let mtimeMs: number | null = null
      try {
        const { stat } = await import('@tauri-apps/plugin-fs')
        const info = await stat(path)
        mtimeMs = info.mtime ? new Date(info.mtime).getTime() : null
      } catch {
        continue
      }
      if (mtimeMs !== null && mtimeMs <= entry.timestamp) continue

      let current: string
      try {
        current = await invoke<string>('read_file', { path })
      } catch {
        continue
      }
      const newHash = simpleHash(current)
      const previousContent = entry.content
      const touchedOnly = newHash === entry.hash

      // Refresh state even when content is identical — bumps the stored
      // timestamp past the new mtime so the sweep stops re-stat-reading
      // a file that was merely touched.
      const now = Date.now()
      this.readFileTimestamps.set(path, { timestamp: now, hash: newHash })
      this.readFileState.set(path, {
        content: current,
        timestamp: now,
        offset: entry.offset,
        limit: entry.limit,
        hash: newHash,
        fsVersion: getFsVersion(),
      })

      if (touchedOnly) continue
      const snippet = getSnippetForTwoFileDiff(previousContent, current)
      // Whitespace-only/no-hunk edits yield '' — claude-vaz skips those.
      if (snippet === '') continue
      changed.push({ path, snippet })
    }
    return changed
  }

  /**
   * Bloqueia enquanto houver uma intervenção obrigatória do utilizador
   * pendente (gate de pausa global — ver o call-site no execute()).
   * Polling de 120ms em vez de subscriptions: só corre enquanto um gate
   * está aberto (caso raro e human-paced), e evita gerir 4 subscrições
   * zustand com cleanup por chamada concorrente. O abort interrompe a
   * espera imediatamente no próximo tick.
   */
  private async waitForUserGates(signal?: AbortSignal): Promise<void> {
    const gateOpen = (): boolean => {
      try {
        if (usePermissionStore.getState().pendingPermission) return true
        if (useAskUserQuestionStore.getState().pending.size > 0) return true
        if (useCredentialRequestStore.getState().pending.size > 0) return true
        if (hasPendingDiffApprovals()) return true
      } catch {
        return false
      }
      return false
    }
    while (gateOpen()) {
      if (signal?.aborted) return
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    toolCallId?: string,
    signal?: AbortSignal,
    memoryScope?: string | null,
  ): Promise<string> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`)
    }

    // Per-invocation memory scope — passed by SafeToolPool via execute().
    // Memory tools read from execInput._memoryScope (via getMemoryScope(input)
    // helper in memoryOps.ts). Always reset to prevent leakage between
    // main-agent and sub-agent tool calls.
    this.memoryScopeAgentType = memoryScope ?? null

    // Phase B: pre-check abort signal at entry. If the loop already cancelled
    // before this tool got dispatched (e.g., user hit ESC during streaming),
    // skip permission prompts and execution entirely. Tools that have
    // expensive side effects (subprocess spawn, network) check the signal
    // again mid-execution via input._abortSignal — that's their job.
    if (signal?.aborted) {
      return `Tool ${toolName} aborted before execution (user cancelled).`
    }

    // PAUSA GLOBAL (2026-06-11, pedido do user): enquanto houver QUALQUER
    // intervenção obrigatória do utilizador pendente — prompt de permissão,
    // ask_user_question, request_credentials, aprovação de diff — NENHUM
    // outro tool pode começar a executar. Sem isto, tool calls paralelas
    // (concurrencySafe) e safe-tools auto-aprovadas continuavam a correr
    // por trás do diálogo, nos dois modos. Não há deadlock: o tool que CRIA
    // o gate já passou esta entrada (o seu prompt abre depois), e todos os
    // gates são resolvidos pelo utilizador ou limpos no cancelLoop.
    await this.waitForUserGates(signal)
    if (signal?.aborted) {
      return `Tool ${toolName} aborted before execution (user cancelled).`
    }

    // Malformed args: streaming truncated the JSON and we couldn't fully
    // repair it. Rather than pass incomplete args to Tauri (which produces
    // cryptic serde errors like "missing required key query"), return a
    // clear error so the model can retry with correct arguments.
    if (input._parseError === true) {
      const raw = (input._raw as string) || ''
      // Try one last repair — our repairPartialJson is in agentService, but
      // a simple regex fallback works for the common truncation case.
      const repaired = raw
        .replace(/,\s*([}\]])/g, '$1')  // trailing commas
      // Count unescaped quotes to detect unclosed strings
      const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length
      let closed = repaired
      if (quoteCount % 2 !== 0) closed += '"'
      // Close unclosed braces
      const opens: string[] = []
      for (const ch of closed) {
        if (ch === '{' || ch === '[') opens.push(ch)
        if (ch === '}' && opens.length && opens[opens.length - 1] === '{') opens.pop()
        if (ch === ']' && opens.length && opens[opens.length - 1] === '[') opens.pop()
      }
      for (let i = opens.length - 1; i >= 0; i--) {
        closed += opens[i] === '{' ? '}' : ']'
      }
      try {
        const repairedArgs = JSON.parse(closed)
        // Success! Use the repaired args, flagging them as partial so
        // downstream code knows some values may be truncated.
        input = { ...repairedArgs, _parseError: 'partial' }
      } catch {
        // Even repair failed — give the model a useful error message.
        const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw
        return `Error: tool arguments could not be parsed (streaming truncated the JSON). Raw args preview: ${preview}\n\nPlease retry the tool call with properly formatted JSON arguments. Ensure all required parameters (e.g., "query" for search_in_files) are provided.`
      }
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
    const filePath = (input.file_path || input.oldPath || '') as string
    if (this.isEnvFile(filePath) && ['read_file', 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file'].includes(toolName)) {
      return 'Blocked: .env files contain secrets and cannot be read or modified by the agent. Ask the developer what environment variables are needed, or create a .env.example with placeholder values.'
    }

    // Path scope check — file tools targeting paths outside all allowed
    // roots (project + additionalDirectories) prompt the user for access.
    const FILE_SCOPE_TOOLS = new Set([
      'read_file', 'write_file', 'edit_file', 'create_file',
      'create_directory', 'delete_file', 'rename_file', 'copy_file',
      'list_directory', 'search_files', 'glob', 'path_exists', 'append_file',
      'execute_command', 'execute_command_background', 'agent_shell_start'
    ])
    const pathForScope = (input.file_path || input.oldPath || input.directory || input.cwd || '') as string
    if (pathForScope && FILE_SCOPE_TOOLS.has(toolName)) {
      const scopeCheck = this.checkPathScope(pathForScope)
      if (!scopeCheck.allowed) {
        const decision = await usePermissionStore.getState()
          .requestPathAccess(pathForScope, scopeCheck.directoryToAdd)
        this.recordPermission(toolCallId, decision)
        if (!decision.approved) {
          const reason = decision.denyReason
            ? ` User says: ${decision.denyReason}`
            : ' Ask the user how to proceed.'
          return `Blocked: "${pathForScope}" is outside the ${scopeCheck.scopeName}.${reason}`
        }
      }
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

      // M4b — update_tasks must follow write_file('<plan artefact>').
      // The task list mirrors the plan's Implementation Phases; without a
      // written plan the tasks have no source-of-truth to derive from.
      if (toolName === 'update_tasks' && !this.planFileWritten) {
        return `Blocked in /plan architect mode: ${toolName} must follow write_file('${this.planModePlanFileName}'). The task list mirrors ${this.planModePlanFileName}'s Implementation Phases — write the plan first, then derive tasks from its phase structure (one task per coherent unit of work, IDs like "1.1", "1.2", "2.1" matching the phase numbering). Calling update_tasks before write_file is a contract violation.`
      }

      // M5 — Strict STOP after both PLAN.md and update_tasks have completed.
      // The architect's role is finished; any further tool call drifts into
      // implementation. The next phase (TODO generation, then execution) runs
      // in a fresh turn after the developer approves the plan card.
      if (this.planFileWritten && this.planTasksSeeded) {
        return `Blocked in /plan architect mode: ${this.planModePlanFileName} is written and the task tracker is seeded. Your role for this turn is complete. Stop calling tools and end the turn with a 3-sentence chat summary — TODO generation runs after the developer approves the plan card.`
      }
    }

    // Sensitive files require explicit developer authorization
    const isSensitive = toolName === 'read_file' && this.isSensitiveFile(input.file_path as string)

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
        // RACE FIX: o utilizador pode ter feito stop ENQUANTO o diálogo
        // estava aberto e o clique de aprovação correr contra o abort. A
        // aprovação não pode ressuscitar um run cancelado — re-verificar o
        // signal DEPOIS do await, não só à entrada do execute().
        if (signal?.aborted) {
          return `Tool ${toolName} aborted before execution (user cancelled).`
        }
        dangerousAlreadyApproved = true
      }
    }

    // Agent-internal tools + tools that surface their own confirmation UI:
    // bypass the generic permission dialog. update_tasks/check_team/task
    // are autonomous; request_credentials renders a secure form in the chat
    // (Save/Skip is the gate, not the permission dialog); ask_user_question
    // renders an interactive question card (Submit/Cancel is the gate).
    const PERMISSION_EXEMPT_TOOLS = new Set([
      'update_tasks',
      'collect_results',
      'delegate',
      'check_background_commands',
      'agent_shell_read',
      'agent_shell_stop',
      'request_credentials',
      'ask_user_question',
    ])

    if (!dangerousAlreadyApproved && !PERMISSION_EXEMPT_TOOLS.has(toolName)) {
      const decision = await usePermissionStore.getState().requestPermission(toolName, input, isSensitive ? 'sensitive_file' : false)
      this.recordPermission(toolCallId, decision)
      if (!decision.approved) {
        const target = (input.file_path || input.command || input.name || '') as string
        const reason = decision.denyReason
          ? ` User says: ${decision.denyReason}`
          : ' Ask the user what they want instead or suggest an alternative approach.'
        return `Permission denied by user for ${toolName}${target ? ` (${target})` : ''}.${reason}`
      }
      // RACE FIX: aprovação que chega depois de um stop não pode executar a
      // tool num run morto — re-verificar o signal DEPOIS do await (a
      // verificação à entrada do execute() aconteceu antes do diálogo).
      if (signal?.aborted) {
        return `Tool ${toolName} aborted before execution (user cancelled).`
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
    // Per-call memory scope — sub-agent runner passes this so memory tools
    // scope writes correctly without shared mutable state.
    if (memoryScope) execInput._memoryScope = memoryScope

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
  /** Disk directory for persisting large results across session reloads.
   *  Set by setLargeResultsDir() when a session is loaded. When null,
   *  disk persistence is disabled (in-memory only). */
  private largeResultsDir: string | null = null
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
   * Set the disk directory for large result persistence. Called when a
   * session is loaded so that large results survive session reloads.
   * Pass null to disable disk persistence (in-memory only).
   */
  setLargeResultsDir(dir: string | null): void {
    this.largeResultsDir = dir
  }

  /**
   * Persist a large result to disk (fire-and-forget). Writes to
   * `<largeResultsDir>/<refId>.txt`. Errors are silently ignored —
   * the in-memory Map is the primary store, disk is a fallback.
   */
  private persistLargeResultToDisk(refId: string, content: string): void {
    if (!this.largeResultsDir) return
    const path = `${this.largeResultsDir}/${refId}.txt`
    import('@/utils/invokeMetrics')
      .then(({ invoke }) => invoke('write_file', { path, content }))
      .catch(() => { /* disk persistence is best-effort */ })
  }

  /**
   * Read a large result from disk (async). Returns null if not found
   * or if disk persistence is disabled.
   */
  async readLargeResultFromDisk(refId: string): Promise<string | null> {
    if (!this.largeResultsDir) return null
    try {
      const { invoke } = await import('@/utils/invokeMetrics')
      const path = `${this.largeResultsDir}/${refId}.txt`
      return await invoke<string>('read_file', { path })
    } catch {
      return null
    }
  }

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

    // Persist to disk (fire-and-forget) so large results survive session reloads.
    this.persistLargeResultToDisk(refId, result)

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

    // Accumulate full output into commandLogs for the terminal-style log viewer.
    // Each chunk may contain multiple lines. Append in one store update to
    // avoid React/Zustand nested update explosions on verbose commands.
    const chunks = data.split('\n')
    useChatStore.getState().appendToolCallCommandLogs(toolCallId, chunks)

    // Show the last meaningful line as progress (single-line summary)
    const lines = data.trim().split('\n')
    const lastLine = lines[lines.length - 1] || ''
    if (lastLine.length > 0) {
      const display = lastLine.length > 80 ? lastLine.slice(0, 80) + '...' : lastLine
      useChatStore.getState().updateToolCallProgress(toolCallId, display)
    }
  }

  /**
   * Runs build/test/lint/script commands via streaming (run_streaming_command)
   * so the user sees real-time log output in the chat via both `progressText`
   * (last-line summary) and `commandLogs` (full scrollable log).
   *
   * Similar to `executeInstallStreaming` but generalized for non-install commands
   * and with a shorter default timeout (120s vs 300s).
   */
  private async executeStreamingCommand(
    command: string,
    cwd: string,
    toolCallId?: string,
    abortSignal?: AbortSignal,
    timeoutSecs: number = 120,
  ): Promise<string> {
    const tcId = toolCallId
    const allOutput: string[] = []

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
        useChatStore.getState().updateToolCallProgress(tcId, 'Running...')
      }

      const pidOrResult = await invoke<number | { stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean }>('run_streaming_command', { command, cwd })
      if (typeof pidOrResult !== 'number') {
        cleanup()
        const result = pidOrResult
        if (result.timedOut) {
          return `TIMEOUT: Command exceeded ${timeoutSecs}s limit and was terminated.\nFor long-running processes, use start_dev_server instead.\nSTDERR:\n${result.stderr}`
        }
        let output = ''
        if (result.stdout) output += result.stdout
        if (result.stderr) output += `${output ? '\n' : ''}STDERR:\n${result.stderr}`
        output += `${output ? '\n' : ''}Exit code: ${result.exitCode}`
        this.detectServerUrl(output)
        return output
      }
      const pid = pidOrResult
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

      const COMMAND_TIMEOUT = timeoutSecs * 1000
      let timeoutTimer: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<number>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`Command timed out after ${timeoutSecs}s`)), COMMAND_TIMEOUT)
      })

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
          const isMutating = this.matchStateMutatingCommand(command) !== null
          const hasWritePattern = ToolExecutor.WRITE_COMMAND_PATTERNS.some(p => p.test(command))
          const couldMutate = isMutating || hasWritePattern
          const truncated = command.length > 80 ? command.slice(0, 80) + '...' : command
          if (couldMutate) {
            return `Command CANCELLED by user mid-execution: ${truncated}\nExit code: 1\n\nWARNING: this command can mutate state (matches a state-mutating pattern or write operation). The process was killed, but partial side effects (file writes, mv/rm, package mutations) MAY have already occurred.\n\nDO NOT auto-retry. Ask the user what they observed before deciding the next step.`
          }
          return `Command cancelled by user: ${truncated}\nExit code: 1\n\nThe command was non-mutating (read-only / diagnostic). Safe to retry if needed, or move on.`
        }
        return `TIMEOUT: ${msg}\n${allOutput.join('')}\nThe command was killed due to timeout.`
      }

      const fullOutput = allOutput.join('')

      if (tcId) {
        useChatStore.getState().updateToolCallProgress(tcId, '')
      }

      // Detect dev server URL in output
      this.detectServerUrl(fullOutput)

      if (exitCode === 0) {
        const lines = fullOutput.split('\n')
        const tail = lines.length > 30 ? lines.slice(-30).join('\n') : fullOutput
        return `${tail}\nExit code: 0`
      }

      // Failure: return full output for model to diagnose
      return `${fullOutput}\nExit code: ${exitCode}`
    } catch (error) {
      cleanup()
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to run command: ${msg}`
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
    const project = useProjectStore.getState().currentProject
    if (project?.path) return project.path
    // CMD-mode fallback: TerminalView never populates currentProject
    // (it invokes Rust open_project directly). cmdModeProjectPath is set
    // by the WelcomeScreen and persists for the entire CMD session.
    const cmdPath = useProjectStore.getState().cmdModeProjectPath
    if (cmdPath) return cmdPath
    if (this.cmdModeCwd) return this.cmdModeCwd
    throw new Error('No project is open. Cannot perform file operations without an active project.')
  }

  /** All directories the agent is allowed to access: project root + user-approved extras. */
  private getAllowedRoots(): string[] {
    const roots: string[] = []
    const projectRoot = this.cmdModeCwd || this.getProjectRoot()
    if (projectRoot) roots.push(projectRoot)
    const { additionalDirectories } = usePermissionStore.getState()
    for (const dir of additionalDirectories) roots.push(dir)
    return roots
  }

  private isPathWithinRoots(normalizedTarget: string, roots: string[]): boolean {
    const isWindowsPath = /^[A-Z]:\//.test(normalizedTarget)
    const targetCmp = isWindowsPath ? normalizedTarget.toLowerCase() : normalizedTarget
    for (const root of roots) {
      const rootNorm = normalizePath(root)
      const rootCmp = isWindowsPath ? rootNorm.toLowerCase() : rootNorm
      if (targetCmp === rootCmp || targetCmp.startsWith(`${rootCmp}/`)) return true
    }
    return false
  }

  private validatePathWithinProject(filePath: string): void {
    const resolvedPath = this.resolveToAbsolute(filePath)
    const target = normalizePath(resolvedPath)
    if (this.isPathWithinRoots(target, this.getAllowedRoots())) return

    const scopeName = this.cmdModeCwd ? 'working directory' : 'project directory'
    throw new Error(`Access denied: path "${filePath}" is outside the ${scopeName}`)
  }

  /** Check if a file path is within any allowed root. Returns the top-level
   *  directory that would need to be approved if the path is outside scope. */
  private checkPathScope(filePath: string): { allowed: boolean; directoryToAdd: string; scopeName: string } {
    const resolvedPath = this.resolveToAbsolute(filePath)
    const target = normalizePath(resolvedPath)
    const roots = this.getAllowedRoots()

    if (this.isPathWithinRoots(target, roots)) {
      return { allowed: true, directoryToAdd: '', scopeName: '' }
    }

    // Find the top-level directory to suggest adding.
    // Walk up from the file until we find a directory that shares a common
    // parent with the project root — that sibling directory is the natural
    // "grant access to X" scope.
    const projectRoot = normalizePath(this.cmdModeCwd || this.getProjectRoot())
    const parts = target.split('/')
    const rootParts = projectRoot.split('/')

    // Find common prefix length
    let commonLen = 0
    for (let i = 0; i < Math.min(parts.length, rootParts.length); i++) {
      if (parts[i] === rootParts[i]) commonLen = i + 1
      else break
    }

    // The directory to add is the first divergent segment from the target side
    // e.g. root=/Users/me/project, target=/Users/me/other/src/file.ts
    //   commonLen=3 (/Users/me), directoryToAdd=/Users/me/other
    const directoryToAdd = parts.slice(0, commonLen + 1).join('/') || target

    const scopeName = this.cmdModeCwd ? 'working directory' : 'project directory'
    return { allowed: false, directoryToAdd, scopeName }
  }
  
  /**
   * Resolve a potentially relative path to an absolute path.
   * If the path is relative (doesn't start with '/' on Unix or 'C:\\' / 'C:/' on Windows),
   * resolve it against the project root (or cmdModeCwd).
   */
  private resolveToAbsolute(p: string): string {
    if (!p) return p
    // `~` / `~/x` — expand to the user's home dir (mirrors claude-vaz). Sem
    // isto, `~/Documents` era tratado como relativo e virava
    // `<project>/~/Documents` — um not-found confuso em vez de um prompt
    // de acesso ao diretório real.
    if (this.homeDir && (p === '~' || p.startsWith('~/'))) {
      return p === '~' ? this.homeDir : `${this.homeDir.replace(/\/+$/, '')}/${p.slice(2)}`
    }
    // Already absolute
    if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) {
      return p
    }
    // Relative path — resolve against project root or cmdModeCwd
    const base = this.cmdModeCwd || this.getProjectRoot()
    if (!base) return p // Can't resolve, return as-is
    // Normalize: join base + relative, handle leading slashes in relative
    const normalized = p.startsWith('./') ? p.slice(2) : p
    return `${base.replace(/\/+$/, '')}/${normalized}`
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
    // CMD/Terminal mode is stack-free — no data-layer restriction applies.
    // The forbidden deps list (FORBIDDEN_DATA_LAYER_DEPS) is a Chat-mode /
    // Publish-flow constraint only. Terminal mode must be able to install
    // any database driver (mysql2, pg, Prisma, etc.) without mechanical
    // rejection from the harness.
    if (this.cmdModeCwd) return null
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
    return checkPlanModeAccess(toolName, filePath, this.getProjectRoot(), this.planModePlanFileName)
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
  private recordPermission(toolCallId: string | undefined, decision: { approved: boolean; prompted: boolean; source: string; promptKind?: import('../../stores/permissionStore').PromptReason; denyReason?: string }): void {
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
      let appCheck: Record<string, string> = {}
      try {
        appCheck = await getAppCheckHeader()
      } catch (err) {
        console.warn('[toolExecutor] failed to get App Check header:', err)
      }
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Request-Type': 'web_search',
          ...appCheck,
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

    // The worker returns an OpenAI SSE stream. We only need the final text,
    // so accumulate choices[].delta.content into a single string.
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
            const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
            const content = chunk.choices?.[0]?.delta?.content
            if (content) {
              answer += content
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
    const now = Date.now()
    const hash = this.simpleHash(newContent)
    this.readFileTimestamps.set(path, {
      timestamp: now,
      hash,
    })
    // Capture the current fsVersion BEFORE the bump — write entries have
    // offset=undefined so they're excluded from dedup anyway; the fsVersion
    // here is for completeness and for the edit_file cache optimization.
    const versionBeforeBump = getFsVersion()
    // Update the content cache too — offset=undefined marks this as a
    // write source, which is excluded from dedup (the model hasn't
    // re-read the file yet, so deduping would point it at stale content).
    this.readFileState.set(path, {
      content: newContent,
      timestamp: now,
      offset: undefined,
      limit: undefined,
      hash,
      fsVersion: versionBeforeBump,
    })
    // Bump the global filesystem fingerprint. Cache keys that include it
    // (system prompt, skills) miss on the next read so the IDE sees the
    // real post-write state. Path-agnostic by design — see fsVersion.ts.
    bumpFsVersion(`write:${path}`)
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
    // Plan-mode progress: the active plan artefact at the project root unblocks update_tasks
    // and enables the strict-STOP guard once update_tasks has also run.
    if (this.planMode && isPlanArtefactAtRoot(path, this.getProjectRoot(), this.planModePlanFileName)) {
      const basename = path.replace(/\\/g, '/').split('/').pop()
      if (basename === this.planModePlanFileName) this.planFileWritten = true
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

  private async ensureAgentShellListeners(): Promise<void> {
    if (this.agentShellListenersReady) return this.agentShellListenersReady

    this.agentShellListenersReady = Promise.all([
      listen<PtyOutputEvent>('pty-output', (event) => {
        const session = this.agentShellSessions.get(event.payload.session_id)
        if (!session) return
        const clean = this.cleanPtyOutput(event.payload.data)
        if (!clean) return
        session.output += clean
        if (session.output.length > AGENT_SHELL_MAX_BUFFER_CHARS) {
          const overflow = session.output.length - AGENT_SHELL_MAX_BUFFER_CHARS
          session.output = session.output.slice(overflow)
          session.readOffset = Math.max(0, session.readOffset - overflow)
        }
        session.updatedAt = Date.now()

        if (session.activeToolCallId) {
          const lines = clean.split('\n')
          useChatStore.getState().appendToolCallCommandLogs(
            session.activeToolCallId,
            lines.map(line => line.replace(/\r/g, '')),
          )
        }
      }),
      listen<PtyExitEvent>('pty-exit', (event) => {
        const session = this.agentShellSessions.get(event.payload.session_id)
        if (!session) return
        session.exited = true
        session.exitCode = event.payload.exit_code
        session.activeToolCallId = null
        session.updatedAt = Date.now()
      }),
    ]).then(() => undefined)

    return this.agentShellListenersReady
  }

  private cleanPtyOutput(data: string): string {
    const withoutBackspaces: string[] = []
    for (const ch of data) {
      if (ch === '\b') withoutBackspaces.pop()
      else withoutBackspaces.push(ch)
    }

    return withoutBackspaces.join('')
      // Strip common ANSI/VT escape sequences so model-visible output and the
      // lightweight transcript do not fill with prompt color/control codes.
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
  }

  private validateAgentShellInput(data: string): string {
    const command = data.replace(/\n+$/g, '').trim()
    if (!command) throw new Error('Agent shell input cannot be empty.')
    if (command.includes('\n')) {
      throw new Error('Agent shell input must contain exactly one terminal action. Send separate agent_shell_write calls for multiple lines.')
    }
    return command
  }

  private getAgentShellSession(id?: string): AgentShellSession {
    const sessionId = id || this.lastAgentShellSessionId
    if (!sessionId) throw new Error('No active agent shell session. Call agent_shell_start first.')
    const session = this.agentShellSessions.get(sessionId)
    if (!session) throw new Error(`Agent shell session not found: ${sessionId}`)
    return session
  }

  private async waitForAgentShellOutput(session: AgentShellSession, startLength: number, waitMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 10_000))
    while (Date.now() < deadline) {
      if (session.output.length > startLength || session.exited) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  private readAgentShellDelta(session: AgentShellSession, maxChars: number = 20_000): string {
    const from = Math.min(session.readOffset, session.output.length)
    let delta = session.output.slice(from)
    if (delta.length > maxChars) {
      delta = delta.slice(-maxChars)
      delta = `[output truncated to last ${maxChars} chars]\n${delta}`
    }
    session.readOffset = session.output.length
    return delta.trimEnd()
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
        description: 'Read the contents of a file at the given file_path. By default reads the entire file; for large files use `offset` + `limit` to read a line range (1-indexed), matching Claude Code\'s Read tool semantics. Files larger than 256 KB throw with instructions to use offset/limit — auto-truncating would waste 25K+ tokens of context vs. the model refining its call. When you already know which part of the file you need, only read that part — this is important for larger files.',
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
        let filePath = input.file_path as string
        // Resolve relative paths to absolute (agent often sends relative paths)
        filePath = this.resolveToAbsolute(filePath)
        
        // Detect "provided" BEFORE clamping — Math.max(1, 0) would turn
        // a missing offset into 1 and make sliceRequested always true.
        const offsetProvided = typeof input.offset === 'number' && input.offset > 0
        const limitProvided = typeof input.limit === 'number' && input.limit > 0
        const offset = offsetProvided ? Math.max(1, input.offset as number) : 1
        const limit = limitProvided ? Math.max(1, input.limit as number) : 0
        const sliceRequested = offsetProvided || limitProvided
        this.validatePathWithinProject(filePath)

        // ── Dedup check ──────────────────────────────────────────────
        // If we've already read this exact file+range and no writes have
        // occurred since (fsVersion unchanged), return a short stub instead
        // of re-sending the full content. The earlier tool_result is still
        // in the conversation context — two full copies waste cache_creation
        // tokens. Uses fsVersion (O(1)) instead of re-reading the file.
        // Mirrors claude-vaz FileReadTool.ts:523-573.
        const currentFsVersion = getFsVersion()
        const dedupResult = checkReadDedup(
          filePath,
          offsetProvided ? offset : undefined,
          limitProvided ? limit : undefined,
          this.readFileState,
          currentFsVersion,
        )
        if (dedupResult.isDuplicate && dedupResult.stub) {
          return dedupResult.stub
        }

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
          const now = Date.now()
          this.readFileTimestamps.set(filePath, { timestamp: now, hash: newHash })

          // ── Update content cache ────────────────────────────────────
          // Store the file content in the cache for dedup and state recovery.
          // offset/limit reflect what was actually requested so future dedup
          // checks can match exact ranges. fsVersion is captured so the
          // dedup freshness check is O(1) — no need to re-read the file.
          this.readFileState.set(filePath, {
            content: fullContent,
            timestamp: now,
            offset: offsetProvided ? offset : undefined,
            limit: limitProvided ? limit : undefined,
            hash: newHash,
            fsVersion: currentFsVersion,
          })

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
          if (/not found|pathnotfound|no such file|does not exist/i.test(msg)) {
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
            file_path: { type: 'string', description: 'Absolute path to the directory to list' },
            maxDepth: { type: 'number', description: 'Maximum depth to traverse. Default: 3' }
          },
          required: ['file_path']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.file_path as string)
        const dirPath = this.resolveToAbsolute(input.file_path as string)
        const filter = { showHidden: false, maxDepth: (input.maxDepth as number) || 3 }
        const tree = await invoke('build_file_tree', { rootPath: dirPath, filter })
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
        const query = input.query as string | undefined
        if (!query || !query.trim()) {
          return 'Error: search_files requires a non-empty "query" parameter. Provide a search pattern.'
        }
        this.validatePathWithinProject(input.directory as string)
        const directory = this.resolveToAbsolute(input.directory as string)
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
          directory: directory,
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
            file_path: { type: 'string', description: 'Absolute path to the file to write' },
            content: { type: 'string', description: 'Complete content to write to the file' }
          },
          required: ['file_path', 'content']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.file_path as string)
        const path = this.resolveToAbsolute(input.file_path as string)
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
        // Mirrors claude-vaz FileWriteTool.ts:275-294 (isPartialView check).
        if (!isNewFile) {
          const readState = this.readFileTimestamps.get(path)
          if (!readState) {
            return `Error: You must ${READ_FILE}("${path}") before overwriting it. Read the file first to understand its current content, then call ${WRITE_FILE}.`
          }
          // isPartialView: if the model only saw an auto-injected partial view
          // (e.g. CLAUDE.md with stripped frontmatter), it must do a full Read
          // first — the auto-injected content may not match what's on disk.
          const cachedState = this.readFileState.get(path)
          if (cachedState?.isPartialView) {
            return `Error: You must ${READ_FILE}("${path}") before overwriting it. The content you saw was auto-injected and may not match the file on disk. Read the file first, then call ${WRITE_FILE}.`
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
          this.readFileState.set(path, { content: newContent, timestamp: Date.now(), offset: undefined, limit: undefined, hash: this.simpleHash(newContent), fsVersion: getFsVersion() })
          bumpFsVersion(`write:${path}`)
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
            file_path: { type: 'string', description: 'Absolute path for the new file' },
            content: { type: 'string', description: 'Initial content for the file. Default: empty' }
          },
          required: ['file_path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.file_path as string)
        const path = this.resolveToAbsolute(input.file_path as string)
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
          this.readFileState.set(path, { content, timestamp: Date.now(), offset: undefined, limit: undefined, hash: this.simpleHash(content), fsVersion: getFsVersion() })
          bumpFsVersion(`create:${path}`)
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
            file_path: { type: 'string', description: 'Absolute path of the directory to create' }
          },
          required: ['file_path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.file_path as string)
        const filePath = this.resolveToAbsolute(input.file_path as string)
        await invoke('create_directories_all', { path: filePath })
        this.refreshFileTree()
        return `Directory created successfully: ${filePath}`
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
            file_path: { type: 'string', description: 'Absolute path to delete' }
          },
          required: ['file_path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.file_path as string)
        const filePath = this.resolveToAbsolute(input.file_path as string)

        // Capture checkpoint before deleting. Use injected _toolCallId so
        // concurrent invocations don't race a shared field.
        const tcId = input._toolCallId as string | undefined
        if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: filePath })
            await CheckpointService.getInstance().captureBeforeDelete(
              filePath,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // File might be a directory or unreadable — skip checkpoint
          }
        }

        this.closeEditorIfOpen(filePath)
        await invoke('delete_file_or_directory', { path: filePath })
        this.refreshFileTree()
        // Deletes are filesystem mutations too — bump the version so the
        // next system-prompt build sees the file tree without the gone path.
        bumpFsVersion(`delete:${filePath}`)
        return `Deleted successfully: ${filePath}`
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
        const oldPath = this.resolveToAbsolute(input.oldPath as string)
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
            const content = await invoke<string>('read_file', { path: oldPath })
            const oldPathStr = oldPath
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
          oldPath: oldPath,
          newName
        })
        this.refreshFileTree()
        bumpFsVersion(`rename:${input.oldPath}`)
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
            file_path: { type: 'string', description: 'Absolute path to the file to edit' },
            old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique in the file.' },
            new_string: { type: 'string', description: 'Text to replace old_string with. Use empty string to delete.' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      },
      execute: async (input) => {
        const path = this.resolveToAbsolute(input.file_path as string)
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
            return `${t('tool.wrongFieldNames').replace('{fields}', passedKeys.join(', '))}`
          }
          return t('tool.emptyOldString')
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

        // Enforce read-before-edit: the model must have read the file to know what to edit.
        // Mirrors claude-vaz FileEditTool.ts:275-287 (readFileState + isPartialView).
        const readState = this.readFileTimestamps.get(path)
        if (!readState) {
          return `Error: You must ${READ_FILE}("${path}") before editing it. Read the file first to see the current content, then call ${EDIT_FILE}.`
        }
        // isPartialView: if the model only saw an auto-injected partial view
        // (e.g. CLAUDE.md with stripped frontmatter), it must do a full Read
        // first — the auto-injected content may not match what's on disk.
        const readStateEntry = this.readFileState.get(path)
        if (readStateEntry?.isPartialView) {
          return `Error: You must ${READ_FILE}("${path}") before editing it. The content you saw was auto-injected and may not match the file on disk. Read the file first, then call ${EDIT_FILE}.`
        }

        // Re-read from disk before generating the diff. `fsVersion` only tracks
        // agent writes, so relying on cached content would miss developer or
        // formatter changes made after the model's last read_file.
        const content = await invoke<string>('read_file', { path })
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
          this.readFileState.set(path, { content: newContent, timestamp: Date.now(), offset: undefined, limit: undefined, hash: this.simpleHash(newContent), fsVersion: getFsVersion() })
          bumpFsVersion(`edit:${path}`)
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
        const directory = this.resolveToAbsolute((input.directory as string) || this.getProjectRoot())

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
          return t('tool.notAuthenticated')
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

        // Scope cwd to project root or dynamic terminal directory
        const projectRoot = this.getProjectRoot()
        const cwd = this.resolveToAbsolute((input.cwd as string) || (this.cmdModeCwd || projectRoot))
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

        // Detect build/test/lint/script commands for streaming execution.
        // These commands benefit from real-time log output so the user can
        // monitor progress, see compilation errors as they happen, and get
        // immediate feedback on test results.
        if (isStreamingCommand(cmd)) {
          const timeoutSecs = Math.min(Number(input.timeout_secs) || 120, 600)
          return this.executeStreamingCommand(
            cmd,
            cwd,
            input._toolCallId as string | undefined,
            callSignal,
            timeoutSecs,
          )
        }

        // Agent default: 120s. Clamp to max 600s.
        const timeoutSecs = Math.min(Number(input.timeout_secs) || 120, 600)

        return this.executeStreamingCommand(
          cmd,
          cwd,
          input._toolCallId as string | undefined,
          callSignal,
          timeoutSecs,
        )
      }
    })

    // === start_dev_server ===
    this.tools.set('start_dev_server', {
      definition: {
        name: 'start_dev_server',
        description: `Start the project's dev server as a background process. Returns immediately — the correct preview panel opens automatically when the server is ready. ONE dev server per project.

Pass the command that runs the WHOLE project (e.g. "npm run dev" — even if it fans out frontend+backend via concurrently, workspaces, or turbo).

project_kind: "frontend" (UI-only → iframe preview), "backend" (API-only → HTTP Client panel), "fullstack" (both — iframe + toggleable HTTP Client drawer). Auto-detected if omitted.

Ports: the framework picks the port (Vite=5173, Next=3000, Express=whatever your scripts bind). The IDE detects the URL from log output and classifies frontend/backend by HTTP content-type — you do not need to pass any port.

frontend_port_hint is OPTIONAL: pass it ONLY if both servers happen to respond with the same content-type and the IDE assigned the wrong URL to the iframe. Most projects do not need it.`,
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

    // === delegate (sub-agent delegation — v0.7.0) ===
    this.tools.set('delegate', {
      definition: {
        name: 'delegate',
        description: 'Delegate a task to a team member. Returns immediately — the task runs in background while you continue working.\n\nAvailable team members:\n  Explore — Read-only codebase search (glob, search_files, read_file, list_directory). Use for "find all usages of X", "where is Y defined", "list every file that imports Z".\n  Research — Web research + skill lookup (web_search, web_fetch, read_skill). Use for "find the API docs for X", "what\'s the auth shape of service Y".\n  Verify — Adversarial verification (read + execute, no writes). Use after non-trivial changes (3+ files, backend/API work) to catch issues before reporting done.\n\nAll tasks run in parallel. After delegating:\n  • If you have other work to do (reads, edits, analysis), do it in the same turn.\n  • If you have nothing else to do, end your turn. Team results will be available on your next interaction. Tell the user you delegated the task and will synthesize results when ready.\n  • Do NOT call collect_results immediately after spawning unless you need the results right now to continue your current work.\n\nWhen NOT to use:\n  • The task is a single read_file call — just do it directly.\n  • The task requires editing files — team members are read-only.\n  • You already have the answer in your context.',
        input_schema: {
          type: 'object',
          properties: {
            subagent_type: {
              type: 'string',
              enum: ['Explore', 'Research', 'Verify'],
              description: 'Which team member to delegate to.'
            },
            description: {
              type: 'string',
              description: 'Short label (3-5 words) for the task. Shown in the team activity indicator.'
            },
            prompt: {
              type: 'string',
              description: 'Self-contained task description. The team member sees nothing from your conversation. Be specific about what you need back as a final summary.'
            },
            thoroughness: {
              type: 'string',
              enum: ['quick', 'medium', 'thorough'],
              description: 'Controls search depth. "quick" = first match, stop. "medium" = check 2-3 locations. "thorough" = comprehensive sweep across naming conventions and edge cases. Default: medium.'
            }
          },
          required: ['subagent_type', 'description', 'prompt']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const subagentType = input.subagent_type as string
        const description = (input.description as string) || 'delegation'
        const prompt = input.prompt as string
        const thoroughness = (input.thoroughness as string as 'quick' | 'medium' | 'thorough') || 'medium'

        // Resolve the definition (concurrent limit is checked atomically inside startRun)
        const { getAgentDefinition } = await import('./subAgents/builtInAgents')
        const def = getAgentDefinition(subagentType as 'Explore' | 'Research' | 'Verify')
        if (!def) {
          return `Blocked: unknown sub-agent type '${subagentType}'. Available: Explore, Research, Verify.`
        }

        // Build filtered tools — only the sub-agent's allowed tools
        const allowedTools = new Set(def.tools)
        const disallowedTools = new Set(def.disallowedTools ?? [])
        const filteredTools: OpenAIToolDefinition[] = []
        for (const [name, entry] of this.tools) {
          if (name === 'delegate' || name === 'collect_results') continue // block recursive delegation
          if (disallowedTools.has(name)) continue
          if (allowedTools.has(name)) {
            filteredTools.push({
              type: 'function' as const,
              function: {
                name: entry.definition.name,
                description: entry.definition.description,
                parameters: entry.definition.input_schema,
              },
            })
          }
        }

        // Build parent context
        const settingsStore = (await import('../../stores/settingsStore')).useSettingsStore.getState()
        const parentCtx = {
          cmdOnlyMode: !!this.ctx.getCmdModeCwd(),
          workingPath: this.ctx.getProjectRoot(),
          agentLanguage: settingsStore.agentLanguage ?? 'en',
          thoroughness,
        }

        // Get parent message ID — find the USER message that triggered
        // this turn, not the streaming assistant message (which is last).
        const { useChatStore } = await import('../../stores/chatStore')
        const chatState = useChatStore.getState()
        const activeSessionId = chatState.activeSessionId
        const session = activeSessionId ? chatState.sessions.get(activeSessionId) : null
        const messages = session?.messages || []
        let parentMessageId: string | undefined
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            parentMessageId = messages[i].id
            break
          }
        }

        // Fire and forget — returns immediately. Throws if concurrent limit (4) is reached.
        let runId: string
        try {
          const { runSubAgent } = await import('./subAgents/subAgentRunner')
          runId = await runSubAgent({
            definition: def,
            prompt,
            description,
            parentMessageId,
            parentCtx,
            filteredTools,
          })
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        // Wire subAgentRunIds so SubAgentCard renders in the UI.
        if (parentMessageId) {
          chatState.appendSubAgentRunId(parentMessageId, runId)
        }

        return `Task ${runId} started (${subagentType}: "${description}"). Results will be available when ready.`
      }
    })

    // === collect_results (v0.7.0) ===
    this.tools.set('collect_results', {
      definition: {
        name: 'collect_results',
        description: 'Collect results from team members. Returns immediately with all finished results. If some members are still running, their status is shown but results are not yet available — call collect_results again later to get them. This is non-blocking by design.',
        input_schema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      execute: async () => {
        const { useSubAgentStore } = await import('../../stores/subAgentStore')
        const store = useSubAgentStore.getState()

        // Nothing to check
        if (store.runs.size === 0) {
          return 'No team tasks are active. Use the delegate tool to assign work to team members first.'
        }

        const summaries = store.getRunSummaries()
        const lines: string[] = ['## Team Results\n']

        let runningCount = 0

        for (const s of summaries) {
          const duration = (s.duration / 1000).toFixed(0)
          const icon = s.status === 'completed' ? '✅'
            : s.status === 'error' ? '❌'
            : s.status === 'timeout' ? '⏰'
            : s.status === 'aborted' ? '🛑'
            : '⏳'

          if (s.status === 'running') {
            runningCount++
            // Show last tool call so the user/model can see the sub-agent is making progress
            const run = store.runs.get(s.id)
            const lastTc = run?.toolCalls.length ? run.toolCalls[run.toolCalls.length - 1] : null
            const lastAction = lastTc ? ` — last action: ${lastTc.toolName} (${lastTc.status})` : ''
            lines.push(`### ${icon} ${s.agentType}: "${s.description}" — still running (${duration}s, ${s.toolCallCount} tool calls so far${lastAction})`)
          } else {
            lines.push(`### ${icon} ${s.agentType}: "${s.description}" (${duration}s, ${s.toolCallCount} tool calls)`)
            if (s.tokenUsage) {
              lines.push(`Tokens: ${s.tokenUsage.input.toLocaleString()} in / ${s.tokenUsage.output.toLocaleString()} out`)
            }
            if (s.status === 'error' && s.errorText) {
              lines.push(`Error: ${s.errorText}`)
            } else if (s.finalText) {
              lines.push(s.finalText)
            } else if (s.status === 'aborted') {
              lines.push('Task was aborted.')
            }
          }
          lines.push('') // blank separator
        }

        if (runningCount > 0) {
          lines.push(`${runningCount} team member${runningCount > 1 ? 's' : ''} still working. Results will be available when they finish.`)
        }

        // Only clear completed runs when ALL runs are done (no running left).
        // If some are still running, keep completed ones so the model can still
        // reference them in its next turn (the auto-wake will fire again when
        // the remaining ones finish).
        if (runningCount === 0) {
          store.clearCompleted()
        }

        return lines.join('\n')
      }
    })

    // ── Domain extractions (SOLID decomposition) ─────────────────────
    registerTaskTools(this.ctx)
    registerMemoryTools(this.ctx)
    registerInteractionTools(this.ctx)
    registerProvisionTools(this.ctx)

    // === agent_shell_* (persistent PTY controlled by the agent) ===
    this.tools.set('agent_shell_start', {
      definition: {
        name: 'agent_shell_start',
        description: 'Start a persistent interactive shell session for the agent. Use this when the task benefits from staying inside a real shell or SSH session across multiple steps. Returns a session_id. After this, call agent_shell_write with one command at a time, then agent_shell_read to observe more output.',
        input_schema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory. Defaults to project root or Terminal mode cwd.' },
            wait_ms: { type: 'number', description: 'How long to wait for the initial shell prompt/output. Default: 500. Max: 5000.' },
          },
          required: [],
        },
      },
      execute: async (input) => {
        await this.ensureAgentShellListeners()
        const projectRoot = this.getProjectRoot()
        const cwd = this.resolveToAbsolute((input.cwd as string) || (this.cmdModeCwd || projectRoot))
        this.validatePathWithinProject(cwd)

        const sessionId = `agent-shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const session: AgentShellSession = {
          id: sessionId,
          cwd,
          output: '',
          readOffset: 0,
          activeToolCallId: input._toolCallId as string | null | undefined || null,
          exited: false,
          exitCode: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        this.agentShellSessions.set(sessionId, session)
        this.lastAgentShellSessionId = sessionId

        let shellInfo: InteractiveShellInfo | null = null
        try {
          shellInfo = await invoke<InteractiveShellInfo>('get_interactive_shell_info')
        } catch {
          shellInfo = null
        }

        await invoke<string>('start_pty_shell', { sessionId, cwd })
        await this.waitForAgentShellOutput(session, 0, Math.min(Number(input.wait_ms) || 500, 5000))
        session.activeToolCallId = null

        const initial = this.readAgentShellDelta(session, 8000)
        const lines = [
          `Agent shell started.`,
          `session_id: ${sessionId}`,
          `cwd: ${cwd}`,
        ]
        if (shellInfo) {
          lines.push(`shell: ${shellInfo.kind}`)
          lines.push(`platform: ${shellInfo.platform}`)
          lines.push(`command_style: ${shellInfo.commandStyle}`)
          if (shellInfo.warning) lines.push(`warning: ${shellInfo.warning}`)
        }
        lines.push(initial ? `initial_output:\n${initial}` : 'initial_output: (none yet)')
        return lines.join('\n')
      },
    })

    this.tools.set('agent_shell_write', {
      definition: {
        name: 'agent_shell_write',
        description: 'Write exactly one command/input line to a persistent agent shell session. This keeps the agent inside the same shell/SSH context. Do not include multiple commands, newlines, &&, ||, semicolons, or pipes. Observe output after each write.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session id returned by agent_shell_start. Defaults to the latest agent shell session.' },
            input: { type: 'string', description: 'One command or interactive input line to send.' },
            press_enter: { type: 'boolean', description: 'Append Enter/newline after input. Default: true.' },
            wait_ms: { type: 'number', description: 'How long to wait for output after writing. Default: 1000. Max: 10000.' },
          },
          required: ['input'],
        },
      },
      execute: async (input) => {
        await this.ensureAgentShellListeners()
        const session = this.getAgentShellSession(input.session_id as string | undefined)
        if (session.exited) return `Agent shell session ${session.id} has exited with code ${session.exitCode ?? '?'}. Start a new session.`

        const command = this.validateAgentShellInput(String(input.input || ''))
        const pressEnter = input.press_enter !== false
        const payload = pressEnter ? `${command}\n` : command
        const startLength = session.output.length
        session.activeToolCallId = input._toolCallId as string | null | undefined || null

        await invoke('write_to_pty', { sessionId: session.id, data: payload })
        await this.waitForAgentShellOutput(session, startLength, Math.min(Number(input.wait_ms) || 1000, 10_000))
        session.activeToolCallId = null

        const output = this.readAgentShellDelta(session)
        return [
          `session_id: ${session.id}`,
          `sent: ${command}`,
          output ? `output:\n${output}` : 'output: (none yet)',
          session.exited ? `shell_exit_code: ${session.exitCode ?? '?'}` : 'shell_status: running',
        ].join('\n')
      },
    })

    this.tools.set('agent_shell_read', {
      definition: {
        name: 'agent_shell_read',
        description: 'Read new output from a persistent agent shell session without writing input. Use after agent_shell_write when a command is still running or output is still arriving.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session id returned by agent_shell_start. Defaults to the latest agent shell session.' },
            wait_ms: { type: 'number', description: 'How long to wait for new output before returning. Default: 1000. Max: 10000.' },
            max_chars: { type: 'number', description: 'Maximum characters to return. Default: 20000. Max: 50000.' },
          },
          required: [],
        },
      },
      execute: async (input) => {
        await this.ensureAgentShellListeners()
        const session = this.getAgentShellSession(input.session_id as string | undefined)
        const startLength = session.output.length
        session.activeToolCallId = input._toolCallId as string | null | undefined || null
        await this.waitForAgentShellOutput(session, startLength, Math.min(Number(input.wait_ms) || 1000, 10_000))
        session.activeToolCallId = null
        const maxChars = Math.min(Number(input.max_chars) || 20_000, 50_000)
        const output = this.readAgentShellDelta(session, maxChars)
        return [
          `session_id: ${session.id}`,
          output ? `output:\n${output}` : 'output: (no new output)',
          session.exited ? `shell_exit_code: ${session.exitCode ?? '?'}` : 'shell_status: running',
        ].join('\n')
      },
    })

    this.tools.set('agent_shell_stop', {
      definition: {
        name: 'agent_shell_stop',
        description: 'Stop a persistent agent shell session and release its PTY. Use when the shell/SSH workflow is complete.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session id returned by agent_shell_start. Defaults to the latest agent shell session.' },
          },
          required: [],
        },
      },
      execute: async (input) => {
        const session = this.getAgentShellSession(input.session_id as string | undefined)
        await invoke('kill_pty_session', { sessionId: session.id })
        this.agentShellSessions.delete(session.id)
        if (this.lastAgentShellSessionId === session.id) this.lastAgentShellSessionId = null
        return `Agent shell stopped: ${session.id}`
      },
    })

    // === execute_command_background ===
    this.tools.set('execute_command_background', {
      definition: {
        name: 'execute_command_background',
        description: 'Execute a shell command in the background. Returns immediately with a tracking ID — the command runs while you continue working. Use for long-running operations like npm install, build, or compile that would otherwise block your workflow. The command runs in the project directory. The system auto-wakes you when the command exits; use check_background_commands once to read the result. Do not poll. Max 6 concurrent background commands.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute (e.g., "npm install", "npm run build", "tsc --noEmit")' },
            cwd: { type: 'string', description: 'Working directory. Default: project root' },
            timeout_secs: { type: 'number', description: 'Timeout in seconds. Default: 300. Max: 600.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const cmd = (input.command as string).trim()
        this.validateCommand(cmd)

        const projectRoot = this.getProjectRoot()
        const cwd = (input.cwd as string) || (this.cmdModeCwd || projectRoot)
        this.validatePathWithinProject(cwd)

        const { useBackgroundCommandStore } = await import('../../stores/backgroundCommandStore')
        const bgCmdStore = useBackgroundCommandStore.getState()

        // Fix #4: GC old completed entries before checking concurrency
        bgCmdStore.removeCompleted()

        if (bgCmdStore.getRunningCount() >= 6) {
          return 'Cannot start: maximum 6 background commands running. Wait for one to complete or use check_background_commands.'
        }

        const { listen } = await import('@tauri-apps/api/event')
        const { invoke } = await import('@tauri-apps/api/core')

        const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const allOutput: string[] = []
        let targetPid = 0
        let finished = false
        // Fix #6: declared before listeners so they can clear it on normal exit
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined

        const wakeForTerminalState = (status: 'completed' | 'error' | 'cancelled', exitCode?: number | null) => {
          import('./backgroundCommands/autoWake')
            .then(({ maybeWakeMainAgentForBackgroundCommand }) => {
              maybeWakeMainAgentForBackgroundCommand({ id: cmdId, command: cmd, status, exitCode })
            })
            .catch(() => { /* auto-wake is best-effort */ })
        }

        const bufferedOutput: { pid: number; data: string }[] = []
        const bufferedExit: { pid: number; code: number }[] = []

        // Register listeners BEFORE spawning
        const unOutput = await listen<{ pid: number; stream: string; data: string }>(
          'cmd-output',
          (event) => {
            if (targetPid === 0) {
              bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
            } else if (event.payload.pid === targetPid) {
              allOutput.push(event.payload.data)
              useBackgroundCommandStore.getState().appendOutput(cmdId, event.payload.data)
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
              if (timeoutTimer) clearTimeout(timeoutTimer) // Fix #6
              unOutput(); unExit()
              const code = event.payload.code
              if (code === 0) {
                useBackgroundCommandStore.getState().completeCommand(cmdId, code)
                wakeForTerminalState('completed', code)
                // Send OS notification when command completes successfully
                import('@/services/notificationService').then(({ notify }) => {
                  notify({
                    title: '✅ Command completed',
                    body: cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd,
                    dedupKey: `bgcmd-done-${cmdId}`,
                  })
                })
              } else {
                useBackgroundCommandStore.getState().failCommand(cmdId, `Process exited with code ${code}`)
                wakeForTerminalState('error', code)
                // Send OS notification when command fails
                import('@/services/notificationService').then(({ notify }) => {
                  notify({
                    title: '❌ Command failed',
                    body: `${cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd} (exit ${code})`,
                    evenWhenFocused: true,
                    dedupKey: `bgcmd-fail-${cmdId}`,
                  })
                })
              }
            }
          }
        )

        try {
          const pid = await invoke<number>('run_streaming_command', { command: cmd, cwd })
          targetPid = pid

          // Fix #1: addCommand BEFORE flush — so store entry exists when
          // buffered exit events are processed (avoids completeCommand no-op)
          useBackgroundCommandStore.getState().addCommand({
            id: cmdId,
            command: cmd,
            status: 'running',
            pid,
            exitCode: null,
            output: '',
            startedAt: Date.now(),
            completedAt: null,
          })

          // Flush buffered events (events emitted between spawn and PID assignment)
          for (const ev of bufferedOutput) {
            if (ev.pid === pid) {
              allOutput.push(ev.data)
              useBackgroundCommandStore.getState().appendOutput(cmdId, ev.data)
            }
          }
          for (const ev of bufferedExit) {
            if (ev.pid === pid && !finished) {
              finished = true
              if (timeoutTimer) clearTimeout(timeoutTimer)
              unOutput(); unExit()
              if (ev.code === 0) {
                useBackgroundCommandStore.getState().completeCommand(cmdId, ev.code)
                wakeForTerminalState('completed', ev.code)
              } else {
                useBackgroundCommandStore.getState().failCommand(cmdId, `Process exited with code ${ev.code}`)
                wakeForTerminalState('error', ev.code)
              }
            }
          }

          // If command already exited during flush, return immediately
          if (finished) {
            const result = useBackgroundCommandStore.getState().getById(cmdId)
            const exitInfo = result?.exitCode !== null ? ` (exit ${result?.exitCode})` : ''
            return `Command completed immediately (PID: ${pid}, id: ${cmdId})${exitInfo}. Use check_background_commands once to see results.`
          }

          const timeoutSecs = Math.min((input.timeout_secs as number) || 300, 600)
          timeoutTimer = setTimeout(async () => {
            if (!finished) {
              finished = true
              unOutput(); unExit()
              try { await invoke('kill_process', { pid }) } catch { /* best effort */ }
              useBackgroundCommandStore.getState().failCommand(cmdId, `Timed out after ${timeoutSecs}s`)
              wakeForTerminalState('error', null)
            }
          }, timeoutSecs * 1000)

          // Setup abort listener — kills on agent stop
          const callSignal = input._abortSignal as AbortSignal | undefined
          if (callSignal) {
            callSignal.addEventListener('abort', async () => {
              if (!finished) {
                finished = true
                if (timeoutTimer) clearTimeout(timeoutTimer)
                unOutput(); unExit()
                try { await invoke('kill_process', { pid }) } catch { /* best effort */ }
                useBackgroundCommandStore.getState().cancelCommand(cmdId)
                wakeForTerminalState('cancelled', null)
              }
            }, { once: true })
          }

          return `Background command started (PID: ${pid}, id: ${cmdId}). Continue other work or end your turn; the system will wake you when it exits.`
        } catch (err) {
          unOutput(); unExit()
          const msg = err instanceof Error ? err.message : String(err)
          return `Failed to start background command: ${msg}`
        }
      }
    })

    // === check_background_commands ===
    this.tools.set('check_background_commands', {
      definition: {
        name: 'check_background_commands',
        description: 'Read the status and output of background commands started with execute_command_background. Use once after an auto-wake or after you have done other useful work. Do not call repeatedly to wait; if commands are still running and you have no other work, end your turn.',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional specific command ID to check. Omit to see all.' }
          },
          required: []
        }
      },
      execute: async (input) => {
        const { useBackgroundCommandStore } = await import('../../stores/backgroundCommandStore')
        const bgCmdStore = useBackgroundCommandStore.getState()

        const targetId = input.id as string | undefined

        if (targetId) {
          const cmd = bgCmdStore.getById(targetId)
          if (!cmd) return `No background command found with id: ${targetId}`
          if (cmd.status !== 'running') {
            const { acknowledgeBackgroundCommandWake } = await import('./backgroundCommands/autoWake')
            acknowledgeBackgroundCommandWake(cmd.id)
          }
          return formatBackgroundCommandResult(cmd)
        }

        const all = bgCmdStore.getAll()
        if (all.length === 0) return 'No background commands running or recently completed.'

        const lines: string[] = []
        const { acknowledgeBackgroundCommandWake } = await import('./backgroundCommands/autoWake')
        for (const cmd of all) {
          if (cmd.status !== 'running') {
            acknowledgeBackgroundCommandWake(cmd.id)
          }
          lines.push(formatBackgroundCommandResult(cmd))
        }

        return lines.join('\n\n---\n\n')
      }
    })

    // === verify (adversarial verification sub-agent) ===






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
          'execute_command', 'read_dev_server_logs',
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
          maxTurns: 200,
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
            const target = (args.file_path as string)?.replace(/\\/g, '/').split('/').pop()
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
