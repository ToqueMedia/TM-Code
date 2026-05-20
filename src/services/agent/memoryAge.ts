/**
 * Memory freshness helpers.
 *
 * Persistent memories are point-in-time observations. The longer ago they
 * were written, the higher the chance that the function names, file paths,
 * or flags they cite have been renamed, removed, or never merged.
 *
 * These helpers compute age from an mtimeMs (epoch milliseconds) and produce
 * the strings the prompt builder injects so the model sees freshness inline
 * with each memory rather than treating every entry as equally current.
 *
 * Thresholds (kept here so they're easy to retune from telemetry):
 *
 *   - **1 day**: a memory is "old". `read_memory` prepends a one-line
 *     "this memory is N days old — verify identifiers" warning to the
 *     body so the agent sees the staleness signal exactly when it's
 *     about to use the memory. Aligns with claude-vaz's threshold —
 *     today's memory is current, anything else needs verifying.
 *
 *   - **7 days**: at least one entry past this threshold flips the
 *     section header into "verify before recommending" mode. Section-
 *     wide signal so the agent's general guidance lifts even before
 *     it loads any specific entry's body.
 *
 * Previous thresholds (30 / 60 days) were chosen on the assumption that
 * IDE memories age slower than CLI ones. In practice, even within a few
 * days a function name cited in a memory can be renamed; the risk isn't
 * "preferences stop applying" (those age slowly) — it's "identifiers
 * the memory cites have moved" (which can happen any time the code
 * does). Pulling the threshold down to 1 day exposes that risk earlier.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24

export const MEMORY_OLD_DAYS = 1
export const MEMORY_STALE_DAYS = 7

/** Whole-day age. 0 for "today", 1 for "yesterday", etc. Returns 0 when
 *  mtimeMs is 0 or in the future (clock skew tolerated as "fresh"). */
export function memoryAgeDays(mtimeMs: number, nowMs: number = Date.now()): number {
  if (!mtimeMs || mtimeMs > nowMs) return 0
  return Math.max(0, Math.floor((nowMs - mtimeMs) / MS_PER_DAY))
}

/**
 * True iff the memory should trigger the "verify before recommending"
 * header on the section as a whole. Distinct threshold from the per-entry
 * annotation so the header only appears when at least one memory is
 * genuinely stale (not just "a month old").
 */
export function isMemoryStale(mtimeMs: number, nowMs: number = Date.now()): boolean {
  return memoryAgeDays(mtimeMs, nowMs) >= MEMORY_STALE_DAYS
}

/**
 * Verbose warning prepended to `read_memory` output when the loaded
 * file is past the "old" threshold. Mirrors claude-vaz's surfaced-file
 * header — the staleness signal lands exactly where the agent is about
 * to use the memory (its body), not at the index. Returns empty string
 * for unknown / fresh mtimes so the body is returned unmodified.
 */
export function memoryAgeWarning(mtimeMs: number, nowMs: number = Date.now()): string {
  const days = memoryAgeDays(mtimeMs, nowMs)
  if (days < MEMORY_OLD_DAYS) return ''
  return (
    `> ⚠️ This memory is ${days} day${days === 1 ? '' : 's'} old. ` +
    `Memories are point-in-time observations, not live state — file paths, ` +
    `function names, and env-var names it cites may have moved. ` +
    `Verify identifiers against current code (grep / list_directory / read_file) ` +
    `before asserting them as fact.\n\n`
  )
}
