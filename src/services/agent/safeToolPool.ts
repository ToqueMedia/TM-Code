/**
 * safeToolPool — concurrency-safety-aware tool execution pool.
 *
 * Replaces the unsafe `Promise.all(toolCalls.map(execute))` pattern in
 * agentService with a semaphore-based pool that:
 *
 *   - Runs concurrency-safe tools (read_file, glob, web_fetch, etc.) in
 *     parallel up to MAX_PARALLEL.
 *   - Forces non-concurrency-safe tools (execute_command, write_file, delete_file)
 *     to run alone — no other tool may be in-flight while they execute.
 *   - Preserves input order for the result array (prompt cache stability).
 *   - Threads abort signals so cancellations propagate uniformly.
 *
 * Design rationale:
 *
 *   The pool only handles the `toolExecutor.execute()` phase. Diff approval
 *   (the slow, user-blocking part) is intentionally NOT handled here — the
 *   caller batches all approvals via `Promise.all` in a follow-up phase to
 *   preserve the existing batch diff UX (all InlineDiffs visible at once).
 *
 *   write_file / edit_file / create_file are intentionally classified as
 *   non-concurrency-safe even though their execute phase is read-only
 *   (they only compute diff JSON; the disk write happens later in
 *   DiffService.acceptDiff after approval). This is a defensive default —
 *   future changes that add side effects to write tools won't silently
 *   break parallelism. The serial execution adds <50ms per write, which is
 *   imperceptible compared to the user's approval click latency.
 *
 *   Telemetry counters are returned alongside the results so the caller
 *   can log them in a structured event.
 *
 * Not a stream-as-they-arrive executor — that's a separate Phase D
 * optimization on top of this. The pool is invoked AFTER the SSE stream
 * finishes, with the full set of tool calls known up-front.
 */

import type ToolExecutor from './toolExecutor'
import { formatError } from '../../utils/errors'
import { usePermissionStore } from '../../stores/permissionStore'

/**
 * Wrap `inner` in a timeout that does NOT count time spent waiting for the
 * user to answer a permission dialog.
 *
 * Why: a tool's `execute()` promise covers BOTH the permission request and
 * the actual work. With a flat `Promise.race(execute, setTimeout(timeoutMs))`,
 * the deadline expires while the user is still reading the dialog — the user
 * approves, the HTTP call fires, but the pool already rejected. The user sees
 * a "timed out after 300 seconds" failure even though they approved within a
 * normal human latency. Per project policy: permission waits are unbounded.
 *
 * How: track wall-clock elapsed minus accumulated permission-pending time.
 * When the timer fires, recompute "active" elapsed; if still under
 * `timeoutMs`, reschedule for the remainder. The permission store is the
 * single source of truth for "am I currently waiting on the user?" — we
 * subscribe so transitions in/out of pending state are recorded as they
 * happen, not only when the timer ticks.
 */
export function createPermissionAwareTimeout(toolName: string, timeoutMs: number): {
  promise: Promise<never>
  cleanup: () => void
} {
  const startedAt = Date.now()
  let pendingStartedAt: number | null =
    usePermissionStore.getState().pendingPermission ? startedAt : null
  let totalPausedMs = 0
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const unsubscribe = usePermissionStore.subscribe((state) => {
    const isPending = !!state.pendingPermission
    const wasPending = pendingStartedAt !== null
    if (isPending && !wasPending) {
      pendingStartedAt = Date.now()
    } else if (!isPending && wasPending) {
      totalPausedMs += Date.now() - pendingStartedAt!
      pendingStartedAt = null
    }
  })

  const promise = new Promise<never>((_, reject) => {
    const tick = () => {
      const now = Date.now()
      const currentPause = pendingStartedAt !== null ? now - pendingStartedAt : 0
      const activeMs = now - startedAt - totalPausedMs - currentPause
      if (activeMs >= timeoutMs) {
        reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000} seconds`))
        return
      }
      timeoutHandle = setTimeout(tick, timeoutMs - activeMs)
    }
    timeoutHandle = setTimeout(tick, timeoutMs)
  })

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    unsubscribe()
  }

  return { promise, cleanup }
}

/** A single tool call dispatched to the pool. */
export interface PoolToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** Result of executing a single tool through the pool. */
export interface PoolToolResult {
  toolCall: PoolToolCall
  /** Raw string returned by `toolExecutor.execute()`. */
  rawResult: string
  /** True if execution threw or returned an error. */
  isError: boolean
  /** Parsed diff metadata if the result was a diff JSON (write_file/edit_file/create_file). */
  parsedDiff: { type: string; path: string; isNewFile: boolean; newContent?: string } | null
}

/** Telemetry collected during a single pool run. */
export interface PoolTelemetry {
  totalTools: number
  concurrencySafeCount: number
  serialCount: number
  /**
   * Sizes of each batch as it ran. e.g. [3, 1, 2] = three parallel reads,
   * then one serial bash, then two parallel reads. Length 1 batches with
   * size 1 may be either a single safe tool or a serial tool.
   */
  parallelBatchSizes: number[]
  maxParallelObserved: number
  totalDurationMs: number
  /** How many times the pool blocked a tool from starting because of an
   *  in-flight non-safe tool. The "would-have-been-a-race" metric. */
  concurrencyConflictsAvoided: number
}

/** Options passed to executeToolCalls. */
export interface ExecutePoolOptions {
  toolCalls: PoolToolCall[]
  toolExecutor: ToolExecutor
  /** Loop-level abort signal — pool stops dispatching once aborted. */
  abortSignal: AbortSignal | null | undefined
  /** Per-tool execution timeout. Default: 5 minutes. */
  toolTimeoutMs?: number
  /**
   * Maximum number of concurrency-safe tools allowed to run at the same
   * time. Default: 10 — matches Claude Code's default. Sub-agents may
   * pass a smaller number to bound resource use.
   */
  maxParallel?: number
  /**
   * Hook called BEFORE a tool starts executing. Used by the caller to fire
   * `onToolCallPending`/`onToolCallStart` callbacks at the right moment
   * (right before the tool actually runs, not when it was queued).
   *
   * May be sync or async. If async, the pool does NOT await the returned
   * Promise (the tool starts executing immediately without waiting for the
   * hook to finish). Instead, safeFireCallback attaches a passive .catch()
   * so any async rejection becomes a swallowed log rather than an unhandled
   * rejection that crashes the dispatch loop.
   */
  onToolStart?: (toolCall: PoolToolCall) => void | Promise<void>
  /**
   * Hook called AFTER a tool returns its raw result. Used by the caller
   * to fire `onToolResult` so the UI renders InlineDiffs immediately.
   * The hook receives the raw result string and an isError flag.
   *
   * May be sync or async. Same fire-and-forget semantics as onToolStart:
   * the pool yields the result back to its collection array without
   * awaiting the hook's return. Any async rejection is caught and logged.
   */
  onToolResult?: (toolCall: PoolToolCall, rawResult: string, isError: boolean) => void | Promise<void>
}

/** Default cap on concurrent safe-tool execution. Mirrors Claude Code's CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY default. */
const DEFAULT_MAX_PARALLEL = 10
const DEFAULT_TOOL_TIMEOUT_MS = 300_000 // 5 minutes

/**
 * Execute a batch of tool calls respecting concurrency-safety classification.
 *
 * Returns results in the **same order** as `toolCalls` (NOT completion order)
 * so that downstream prompt-cache key computation is deterministic.
 *
 * Aborts: when `abortSignal.aborted` becomes true, the pool stops dispatching
 * new tools. In-flight tools also receive the same signal via
 * `toolExecutor.execute(name, args, id, signal)` — Phase B threading lets
 * tools that support mid-flight cancellation (execute_command, web_fetch,
 * install commands) actually stop their work. Tools that complete in
 * milliseconds (most reads) just check the signal at entry and skip if set.
 */
export async function executeToolCalls(
  opts: ExecutePoolOptions,
): Promise<{ results: (PoolToolResult | null)[]; telemetry: PoolTelemetry }> {
  const {
    toolCalls,
    toolExecutor,
    abortSignal,
    toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    maxParallel = DEFAULT_MAX_PARALLEL,
    onToolStart,
    onToolResult,
  } = opts

  const startedAt = Date.now()
  const results: (PoolToolResult | null)[] = new Array(toolCalls.length).fill(null)

  // Snapshot concurrencySafe classification for each input slot. We use a
  // snapshot rather than calling toolExecutor.isConcurrencySafe() repeatedly
  // so that mid-run tool re-registration (MCP server reload) can't change
  // a tool's classification mid-batch.
  const isSafeByIndex = toolCalls.map(tc => toolExecutor.isConcurrencySafe(tc.name))

  // Telemetry counters
  let concurrencySafeCount = 0
  let serialCount = 0
  for (const safe of isSafeByIndex) {
    if (safe) concurrencySafeCount++
    else serialCount++
  }
  const parallelBatchSizes: number[] = []
  let maxParallelObserved = 0
  let concurrencyConflictsAvoided = 0

  /**
   * Tracks the indices of tools currently executing. Used to decide whether
   * a queued tool can start now or must wait.
   */
  const inFlight = new Set<number>()

  /** Returns true iff every in-flight tool is concurrency-safe. */
  const allInFlightSafe = (): boolean => {
    for (const idx of inFlight) {
      if (!isSafeByIndex[idx]) return false
    }
    return true
  }

  // Track the size of the current parallel batch — incremented every time a
  // safe tool joins, finalized into parallelBatchSizes when in-flight drains
  // to zero or a serial tool starts.
  let currentBatchSize = 0
  const finalizeBatch = () => {
    if (currentBatchSize > 0) {
      parallelBatchSizes.push(currentBatchSize)
      currentBatchSize = 0
    }
  }

  /**
   * Defensive callback invoker — swallows and logs throws so a buggy
   * caller-supplied hook can't crash the pool. The dispatch loop awaits
   * runOne via Promise.race; an unhandled rejection here would tear down
   * the entire turn mid-execution.
   *
   * Handles BOTH sync throws AND async rejections: if the callback returns
   * something thenable (a Promise), attaches a .catch handler so a later
   * rejection becomes a swallowed log instead of an unhandled rejection
   * that crashes the dispatch loop. Today's callbacks (onToolResult,
   * onToolStart) in agentRunner.ts are all synchronous, but we don't want
   * a future async addition to silently regress.
   */
  const safeFireCallback = (
    cb: (() => void | Promise<void>) | undefined,
    label: string,
  ): void => {
    if (!cb) return
    try {
      const ret = cb()
      // Check thenable first (handles native Promise, Bluebird, etc.) — narrower
      // than `instanceof Promise` because that's runtime-specific.
      if (ret && typeof (ret as { then?: unknown }).then === 'function') {
        ;(ret as Promise<void>).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `safeToolPool: ${label} async callback rejected — swallowed to keep pool alive`,
            err,
          )
        })
      }
    } catch (err) {
      // Use console.error rather than logger to avoid coupling the pool to
      // a specific logger implementation. The integration in agentService
      // can re-emit at higher level if desired.
      // eslint-disable-next-line no-console
      console.error(`safeToolPool: ${label} callback threw — swallowed to keep pool alive`, err)
    }
  }

  /**
   * Execute one tool's `toolExecutor.execute()`, parse diff if present,
   * fire onToolResult, return the PoolToolResult. Internal — never called
   * directly; only via dispatch().
   *
   * Bug history: this function MUST never throw. If it did, the dispatch
   * loop's `await Promise.race(inFlightPromises.values())` would propagate
   * the rejection and crash the entire turn. All callback hooks are wrapped
   * in safeFireCallback to enforce this. The execute() call itself is
   * already wrapped in the try/catch below.
   */
  const runOne = async (index: number): Promise<void> => {
    const toolCall = toolCalls[index]

    // Pre-execute hook — defensive: a buggy chat UI callback must not
    // bring down the pool.
    safeFireCallback(() => onToolStart?.(toolCall), 'onToolStart')

    let result: PoolToolResult
    try {
      // Phase B: thread the loop's abort signal into the tool. Tools that
      // honor it (execute_command, web_fetch, install commands) will stop
      // their subprocess / reject their fetch as soon as the signal fires.
      // Tools that don't honor it just check it at entry and skip.
      // The timeout pauses while a permission dialog is on screen — see
      // createPermissionAwareTimeout for the rationale.
      const timer = createPermissionAwareTimeout(toolCall.name, toolTimeoutMs)
      const raw = await Promise.race([
        toolExecutor.execute(toolCall.name, toolCall.args, toolCall.id, abortSignal ?? undefined),
        timer.promise,
      ]).finally(timer.cleanup)

      // Detect diff payload from write_file / edit_file / create_file
      let parsedDiff: PoolToolResult['parsedDiff'] = null
      try {
        const parsed = JSON.parse(raw)
        if (parsed?.type === 'diff') {
          parsedDiff = {
            type: parsed.type,
            path: parsed.path,
            isNewFile: !!parsed.isNewFile,
            newContent: parsed.newContent,
          }
        }
      } catch {
        // not JSON — fine
      }

      result = {
        toolCall,
        rawResult: raw,
        isError: false,
        parsedDiff,
      }
      safeFireCallback(() => onToolResult?.(toolCall, raw, false), 'onToolResult')
    } catch (error) {
      // Use formatError so plain-object throws (Tauri's typical shape) don't
      // collapse to "[object Object]" in the model's tool-result view.
      const errorMsg = formatError(error)
      result = {
        toolCall,
        rawResult: errorMsg,
        isError: true,
        parsedDiff: null,
      }
      safeFireCallback(() => onToolResult?.(toolCall, errorMsg, true), 'onToolResult(error)')
    }

    results[index] = result
  }

  /**
   * Dispatch loop: walks the input list in order, starting tools when
   * concurrency conditions allow, yielding to in-flight tools when not.
   *
   * Aborts politely on `abortSignal.aborted` — stops dispatching new
   * tools, but lets in-flight ones finish so their results are recorded.
   */
  let nextIndex = 0
  const inFlightPromises = new Map<number, Promise<void>>()

  while (nextIndex < toolCalls.length || inFlight.size > 0) {
    // Abort gate: if signaled, stop dispatching but drain what's running.
    if (abortSignal?.aborted) {
      if (inFlight.size === 0) break
      await Promise.race(inFlightPromises.values())
      // Re-check aborts after each drain step.
      continue
    }

    // Try to dispatch the next tool if conditions allow.
    if (nextIndex < toolCalls.length) {
      const isSafe = isSafeByIndex[nextIndex]
      const empty = inFlight.size === 0
      const allSafeRunning = empty || allInFlightSafe()
      const underCap = inFlight.size < maxParallel

      const canStart =
        empty ||
        (isSafe && allSafeRunning && underCap)

      if (canStart) {
        const idx = nextIndex++

        // Batch tracking: a serial tool always starts a fresh size-1 batch
        // (and never has companions). A safe tool either starts a new batch
        // or joins the running one.
        if (!isSafe) {
          finalizeBatch()
          parallelBatchSizes.push(1)
          // Note: serial tools don't bump currentBatchSize because we
          // already pushed.
        } else {
          currentBatchSize++
        }

        inFlight.add(idx)
        if (inFlight.size > maxParallelObserved) {
          maxParallelObserved = inFlight.size
        }

        const promise = runOne(idx).finally(() => {
          inFlight.delete(idx)
          inFlightPromises.delete(idx)
          // When the parallel batch drains, finalize its size in the log.
          // Serial tools never have a current batch (they were pushed eagerly),
          // so this only fires for safe-tool batches.
          if (inFlight.size === 0 && currentBatchSize > 0) {
            finalizeBatch()
          }
        })
        inFlightPromises.set(idx, promise)
        continue
      }

      // Couldn't start: pool is blocked. Count it as a conflict avoided.
      concurrencyConflictsAvoided++
    }

    // Wait for at least one in-flight tool to finish before re-attempting dispatch.
    if (inFlight.size > 0) {
      await Promise.race(inFlightPromises.values())
    } else {
      // No more to dispatch and nothing running — done.
      break
    }
  }

  // Drain any straggler in-flight (shouldn't happen, but defensive).
  if (inFlight.size > 0) {
    await Promise.all(inFlightPromises.values())
  }
  finalizeBatch()

  const telemetry: PoolTelemetry = {
    totalTools: toolCalls.length,
    concurrencySafeCount,
    serialCount,
    parallelBatchSizes,
    maxParallelObserved,
    totalDurationMs: Date.now() - startedAt,
    concurrencyConflictsAvoided,
  }

  return { results, telemetry }
}

// ══════════════════════════════════════════════════════════════════════════════
// StreamingSafeToolPool — Phase D: dispatch tools DURING SSE streaming
//
// Unlike executeToolCalls (batch — receives all tools at once post-stream),
// this class accepts tools incrementally via addTool(). Each tool starts
// executing immediately when concurrency conditions allow (same safety
// rules as the batch pool: safe tools parallel, non-safe serial).
//
// Usage in processStreamedTurn:
//   1. Create pool before streaming starts
//   2. On each content_block_stop(tool_use): call pool.addTool(toolCall)
//   3. After stream ends: drain remaining results via getRemainingResults()
//
// The benefit: read-only tools (read_file, glob) start executing DURING the
// stream, before the model finishes emitting all tool calls. This saves the
// stream→dispatch latency for multi-tool turns.
// ══════════════════════════════════════════════════════════════════════════════

export class StreamingSafeToolPool {
  private toolExecutor: ToolExecutor
  private abortSignal: AbortSignal | null | undefined
  private onToolResult?: (toolCall: PoolToolCall, rawResult: string, isError: boolean) => void | Promise<void>
  private maxParallel: number
  private toolTimeoutMs: number

  // Queue of tools waiting to be dispatched
  private queue: Array<{ toolCall: PoolToolCall; isSafe: boolean }> = []
  // Tools currently executing
  private inFlight = new Map<string, Promise<PoolToolResult>>()
  private inFlightSafe = new Map<string, boolean>() // id → isSafe
  // Completed results in arrival order
  private completedResults: PoolToolResult[] = []
  // Signal to wake getRemainingResults when a new result is available
  private resultAvailable: (() => void) | null = null
  // Whether addTool() has been called at least once
  private sealed = false
  // Telemetry
  private concurrencyConflictsAvoided = 0
  private startedAt = 0

  constructor(
    toolExecutor: ToolExecutor,
    abortSignal: AbortSignal | null | undefined,
    onToolResult?: (toolCall: PoolToolCall, rawResult: string, isError: boolean) => void | Promise<void>,
    maxParallel = 10,
    toolTimeoutMs = 300_000,
  ) {
    this.toolExecutor = toolExecutor
    this.abortSignal = abortSignal
    this.onToolResult = onToolResult
    this.maxParallel = maxParallel
    this.toolTimeoutMs = toolTimeoutMs
    this.startedAt = Date.now()
  }

  /**
   * Add a tool to the pool. If concurrency conditions allow, execution
   * starts immediately. Otherwise the tool is queued until conditions clear.
   *
   * Called from processStreamedTurn on each content_block_stop(tool_use).
   */
  addTool(toolCall: PoolToolCall): void {
    const isSafe = this.toolExecutor.isConcurrencySafe(toolCall.name)
    this.queue.push({ toolCall, isSafe })
    void this.processQueue()
  }

  /**
   * Signal that no more tools will be added (stream finished).
   * getRemainingResults() uses this to know when to stop waiting.
   */
  seal(): void {
    this.sealed = true
    // Wake up any waiting consumer
    this.resultAvailable?.()
  }

  /**
   * Drain completed results. Yields each result as it becomes available.
   * Blocks until seal() is called AND all in-flight tools finish.
   */
  async *getRemainingResults(): AsyncGenerator<PoolToolResult> {
    while (true) {
      // Yield all completed results
      while (this.completedResults.length > 0) {
        yield this.completedResults.shift()!
      }

      // If sealed and nothing in flight and queue empty → done
      if (this.sealed && this.inFlight.size === 0 && this.queue.length === 0) {
        return
      }

      // Wait for next result. CRITICAL: a result may arrive between the
      // completedResults.length check above and the resolve assignment below
      // (executeTool pushes + calls resultAvailable in a microtask). The
      // re-check inside the Promise constructor prevents the consumer from
      // sleeping forever on a result that's already in the queue.
      await new Promise<void>(resolve => {
        this.resultAvailable = resolve
        // Re-check: result may have arrived between outer check and here
        if (this.completedResults.length > 0 ||
            (this.sealed && this.inFlight.size === 0 && this.queue.length === 0)) {
          resolve()
        }
      })
    }
  }

  /** Telemetry snapshot */
  getTelemetry(): PoolTelemetry {
    return {
      totalTools: this.completedResults.length + this.inFlight.size + this.queue.length,
      concurrencySafeCount: 0, // not tracked per-tool in streaming mode
      serialCount: 0,
      parallelBatchSizes: [],
      maxParallelObserved: 0,
      totalDurationMs: Date.now() - this.startedAt,
      concurrencyConflictsAvoided: this.concurrencyConflictsAvoided,
    }
  }

  private canStart(isSafe: boolean): boolean {
    // Hard gate: while a permission modal is open we don't dispatch ANY new
    // tool, safe or unsafe, parallel or serial. The user has been asked to
    // authorise — until they click, the worker pool stays quiet so the
    // agent isn't reading files / making API calls / doing anything else
    // in the background while the user is mid-decision. Without this gate,
    // a second tool call that arrived in the same turn (e.g., read_file
    // after a write_file with a pending permission) would still fire,
    // breaking the "wait unconditionally for user authorization" contract.
    //
    // Scope (be honest about what this DOESN'T cover):
    //   • Tool calls executed OUTSIDE this pool — currently sub-agents via
    //     `createLightweight` in toolExecutor run their own loop without
    //     visiting this canStart(). They're a separate halt-point; for now
    //     they're rare enough that the gap is acceptable.
    //   • Streaming text from the model. The API turn is already in flight
    //     by the time we ask for permission; the model emits whatever
    //     content it had pending. We can't pause mid-response.
    //   • InlineDiff approvals (write_file/edit_file/create_file). Those
    //     bypass requestPermission entirely via HAS_OWN_APPROVAL and rely on
    //     the "non-safe tool waits for empty in-flight" rule below — which
    //     gives effective serial behaviour without needing this gate.
    if (usePermissionStore.getState().pendingPermission) return false

    if (this.inFlight.size === 0) return true
    if (!isSafe) return false
    // Safe tool can join if all in-flight are safe and under cap
    for (const s of this.inFlightSafe.values()) {
      if (!s) return false
    }
    return this.inFlight.size < this.maxParallel
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.abortSignal?.aborted) break

      const next = this.queue[0]
      if (!this.canStart(next.isSafe)) {
        this.concurrencyConflictsAvoided++
        break // wait for in-flight to drain
      }

      this.queue.shift()
      const { toolCall, isSafe } = next

      this.inFlight.set(toolCall.id, this.executeTool(toolCall, isSafe))
      this.inFlightSafe.set(toolCall.id, isSafe)
    }
  }

  private async executeTool(toolCall: PoolToolCall, _isSafe: boolean): Promise<PoolToolResult> {
    let result: PoolToolResult
    try {
      const timer = createPermissionAwareTimeout(toolCall.name, this.toolTimeoutMs)
      const raw = await Promise.race([
        this.toolExecutor.execute(toolCall.name, toolCall.args, toolCall.id, this.abortSignal ?? undefined),
        timer.promise,
      ]).finally(timer.cleanup)

      let parsedDiff: PoolToolResult['parsedDiff'] = null
      try {
        const parsed = JSON.parse(raw)
        if (parsed?.type === 'diff') {
          parsedDiff = { type: parsed.type, path: parsed.path, isNewFile: !!parsed.isNewFile, newContent: parsed.newContent }
        }
      } catch { /* not JSON */ }

      result = { toolCall, rawResult: raw, isError: false, parsedDiff }

      // Fire callback (defensive — swallow errors)
      try { this.onToolResult?.(toolCall, raw, false) } catch { /* swallow */ }
    } catch (error) {
      // formatError handles Tauri's serde-tagged-enum throws (e.g.
      // FileTreeError serialised as `{"PathNotFound":"..."}`) — without it,
      // String(error) collapses to "[object Object]" which the model sees
      // as a useless tool result.
      const errorMsg = formatError(error)
      result = { toolCall, rawResult: errorMsg, isError: true, parsedDiff: null }
      try { this.onToolResult?.(toolCall, errorMsg, true) } catch { /* swallow */ }
    }

    // Clean up in-flight, push to completed, wake consumer, try next
    this.inFlight.delete(toolCall.id)
    this.inFlightSafe.delete(toolCall.id)
    this.completedResults.push(result)
    this.resultAvailable?.()
    void this.processQueue()

    return result
  }
}
