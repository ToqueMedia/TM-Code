/**
 * Agent configuration constants — single source of truth for all tunables.
 *
 * SRP: this file changes ONLY when configuration values change.
 * All behavioural logic lives elsewhere.
 */

// ── Model / sampling ──

export const MAX_OUTPUT_TOKENS = 32_768
export const DEFAULT_MODEL = 'mimo-v2.5-pro-1m'
export const MIMO_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_CONTEXT_WINDOW = 131_072 // Conservative fallback (128K)

// ── Loop control ──

/** Max auto-continuations when model hits token limit mid-response. */
export const MAX_CONTINUATIONS = 3

/** Max retries when the upstream→worker SSE drops mid-stream. */
export const MAX_INTERRUPT_RETRIES = 3
export const INTERRUPT_BACKOFF_BASE_MS = 500

/** Non-streaming fallback timeout (5 min — claude-vaz uses 300s). */
export const NON_STREAMING_TIMEOUT_MS = 300_000

/** Max retries for completion enforcement (dev-server errors, etc.). */
export const MAX_ENFORCEMENT_RETRIES = 3

// ── Stall detection ──

export const INITIAL_STALL_TIMEOUT_MS = 300_000  // 5 min — first token
export const STREAM_STALL_TIMEOUT_MS = 120_000   // 2 min — between events

// ── Loop detection ──

export const LOOP_DETECTION_THRESHOLD = 3
export const LOOP_SIMILARITY_MIN_LENGTH = 200
export const LOOP_SIMILARITY_RATIO = 0.7

// ── Context compression ──

export const MIN_KEEP_RECENT_TURNS = 4
export const MAX_KEEP_RECENT_TURNS = 12
export const MAX_BACKPRESSURE_RETRIES = 2

// ── Microcompaction ──

export const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 8
export const MICROCOMPACT_KEEP_RECENT_DENSE = 16
export const MICROCOMPACT_GAP_THRESHOLD_MS = 60 * 60 * 1000 // 60 min (cache TTL)
export const MICROCOMPACT_GAP_KEEP_RECENT = 5

// ── Post-compaction recovery ──

export const POST_COMPACTION_REREAD_FILES = 5
export const POST_COMPACTION_FILE_MAX_CHARS = 8000

// ── Reminder re-injection ──

export const REMINDER_REINJECT_INTERVAL_TURNS = 5
export const REMINDER_REINJECT_MIN_TOOLS = 10

// ── BYOK thinking ──

export const BYOK_THINKING_BUDGET_TOKENS = 8_192

// ── Summarization ──

export const SUMMARIZE_TIMEOUT_MS = 90_000

// ── API retry ──

export const API_MAX_RETRIES = 3
export const API_RETRY_DELAYS = [3000, 5000, 10000]
export const API_CF520_DELAYS = [10000, 20000, 30000]
export const API_RATE_LIMIT_DELAY = 20000
