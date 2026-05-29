/**
 * Shared context passed to each domain's `registerXxxTools()` function.
 *
 * Every tool handler that lives in a domain file receives this context
 * instead of `this` (the ToolExecutor instance). This breaks the
 * 4400-line god-class into composable modules while preserving access
 * to the shared mutable state that tools legitimately need.
 *
 * Maps are shared by reference (always live). Primitive getters are
 * functions so the caller always reads the current value, not a stale
 * snapshot from construction time.
 */

/** Stores a read snapshot for concurrent-modification detection. */
export interface ReadTimestamp {
  timestamp: number
  hash: number
}

/**
 * Interface that each domain registration function receives.
 * Only exposes what tools actually need — no private internals leak out.
 */
export interface ToolRegistrationContext {
  // ── Tool map (shared mutable) ──────────────────────────────────────
  tools: Map<string, { definition: { name: string; description: string; input_schema: Record<string, unknown>; concurrencySafe?: boolean; passive?: boolean }; execute: (input: Record<string, unknown>) => Promise<string> }>

  // ── Project root ───────────────────────────────────────────────────
  getProjectRoot(): string

  // ── Path validation (returns normalized path) ──────────────────────
  validatePathWithinProject(filePath: string): string

  // ── Read-before-write bookkeeping (shared Map) ─────────────────────
  readFileTimestamps: Map<string, ReadTimestamp>

  // ── Large result storage (shared Map) ──────────────────────────────
  largeResults: Map<string, string>
  /** Read a large result from disk when the in-memory Map has been
   *  cleared (e.g., after session reload). Returns null if not found. */
  readLargeResultFromDisk(id: string): Promise<string | null>

  // ── CMD mode (getter — reads current value) ────────────────────────
  getCmdModeCwd(): string | null

  // ── Memory scope (getter — reads current value) ────────────────────
  /** When non-null, memory tools write to a sub-agent–scoped directory. */
  getMemoryScopeAgentType(): string | null

  // ── Plan mode (getters — read current values) ──────────────────────
  getPlanMode(): boolean
  getPlanFileWritten(): boolean
  setPlanTasksSeeded(v: boolean): void

  // ── Truncation (delegated to ToolExecutor) ─────────────────────────
  truncateResult(result: string, maxChars?: number): string

  // ── Track shown ranges for large results ───────────────────────────
  trackShownRange(id: string, offset: number, end: number): [number, number] | null

  // ── Hash (delegated to checks.ts) ──────────────────────────────────
  simpleHash(str: string): number

  // ── File tree helpers ──────────────────────────────────────────────
  formatFileTreeCompact(node: Record<string, unknown>, indent?: string): string
  refreshFileTree(): void
  closeEditorIfOpen(path: string): void
  suggestSimilarPath(filePath: string): Promise<string | null>
}
