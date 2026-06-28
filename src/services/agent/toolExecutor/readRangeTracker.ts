/**
 * Read Range Tracker — multi-range overlap dedup for read_file.
 *
 * ⚠️ OVERLAP CHECK IS CURRENTLY DISABLED — see toolExecutor.ts read_file
 * execute(). The multi-range blocker (fully_covered → stub) and the silent
 * range narrowing (partially_covered → adjust) were MORE aggressive than
 * claude-vaz, which only stubs an EXACT range re-read when the file's mtime
 * is unchanged on disk (FileReadTool.ts:523-573) and otherwise trusts the
 * model to re-read overlapping ranges when it judges it needs to. Disabled
 * for parity with Claude's "trust the model" stance.
 *
 * The functions below are retained so the feature can be re-enabled by
 * re-calling checkReadRangeOverlap() in the read_file execute path.
 * recordReadRange() / getReadRanges() / getAndResetOverlapStats() stay
 * live for TELEMETRY: readRanges still reports which ranges the model read,
 * and skippedOverlappingReads / adjustedReadRanges now report 0 (honest
 * signal that overlap interception is off).
 *
 * Original design (kept for reference / re-enable):
 * The existing `readDedup.ts` only stubs a re-read when the requested range
 * matches EXACTLY a prior read (same offset + limit). The agent, however,
 * frequently re-reads OVERLAPPING ranges — e.g. it read lines 1–200, then
 * asks for 1–100 (fully covered) or 150–300 (partially covered). The exact
 * matcher lets both through, billing the model for content it already has.
 *
 * This tracker keeps a list of read ranges per file (not just the last one
 * like FileStateCache, which overwrites on every `set`). When a new read
 * comes in:
 *
 *   - If the requested range is FULLY covered by prior reads (and the file
 *     hasn't changed), return a compact stub — "Range already covered by
 *     previous read_file: file:start-end." — without touching disk.
 *   - If PARTIALLY covered, narrow the request to the missing sub-range so
 *     the model gets only the bytes it doesn't have yet.
 *
 * Freshness
 * ---------
 * Same first gate as readDedup: the global `fsVersion` counter. If it has
 * advanced, ANY prior range may be stale (a write happened somewhere) so we
 * refuse to dedup and let the caller fall through to the signature/content
 * exact-match path in readDedup. When fsVersion is stable, ranges are valid
 * without disk access.
 *
 * This is a module-level singleton (like fsVersion) so both ToolExecutor
 * (records ranges + checks overlap) and query.ts (reads overlap stats for
 * the request-usage export) share one instance. Cleared on
 * resetSessionState().
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ReadRange {
  /** 1-based start line. `undefined`/0 treated as 1. */
  offset: number
  /**
   * Number of lines. `undefined` means read-to-EOF (end = +∞ for interval
   * math).
   */
  limit?: number
  /** Global fsVersion captured at read time. */
  fsVersion: number
}

export type OverlapKind = 'not_covered' | 'fully_covered' | 'partially_covered'

export interface OverlapResult {
  kind: OverlapKind
  /** Present when fully_covered — the stub to return to the model. */
  stub?: string
  /**
   * Present when partially_covered — the missing sub-range the caller should
   * read instead of the originally-requested range. The caller adjusts its
   * offset/limit to this and proceeds.
   */
  adjustedRange?: { offset: number; limit?: number }
}

interface OverlapStats {
  skippedOverlappingReads: number
  adjustedReadRanges: number
}

// ── Interval math ──────────────────────────────────────────────────────

/** Convert a read range to a [startLine, endLine] interval (1-based,
 *  inclusive). `limit === undefined` → endLine = +∞ (read to EOF). */
function toInterval(r: { offset?: number; limit?: number }): [number, number] {
  const start = Math.max(1, r.offset ?? 1)
  const end = r.limit === undefined ? Number.POSITIVE_INFINITY : start + r.limit - 1
  return [start, end]
}

/** Merge overlapping/adjacent intervals into a sorted, disjoint list. */
function mergeIntervals(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    // Adjacent (last[1] + 1 === sorted[i][0]) or overlapping → merge.
    if (sorted[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], sorted[i][1])
    } else {
      merged.push(sorted[i])
    }
  }
  return merged
}

/**
 * Given the merged covered intervals and a requested [reqStart, reqEnd],
 * find the first sub-range of the request that is NOT covered.
 * Returns null when the request is fully covered.
 */
function firstUncovered(
  merged: [number, number][],
  reqStart: number,
  reqEnd: number,
): [number, number] | null {
  let cursor = reqStart
  for (const [s, e] of merged) {
    if (s > cursor) {
      // Gap between cursor and the start of this covered interval.
      const gapEnd = Math.min(s - 1, reqEnd)
      if (cursor <= gapEnd) return [cursor, gapEnd]
    }
    // Advance cursor past this covered interval (if it overlaps the cursor).
    if (e >= cursor) cursor = e + 1
    if (cursor > reqEnd) return null // everything from reqStart is covered
  }
  // Trailing gap after the last covered interval.
  if (cursor <= reqEnd) return [cursor, reqEnd]
  return null
}

// ── Tracker (module-level singleton) ───────────────────────────────────

const byPath = new Map<string, ReadRange[]>()
let stats: OverlapStats = { skippedOverlappingReads: 0, adjustedReadRanges: 0 }

/** Normalise a path for consistent keys (mirrors FileStateCache.normalizePath). */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (s.startsWith('./')) s = s.slice(2)
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/**
 * Check whether a read_file request overlaps ranges already read for this
 * file. The caller passes the CURRENT fsVersion; if it doesn't match the
 * fsVersion stored with the ranges, we return `not_covered` (stale ranges
 * can't be trusted — let readDedup's signature/content path handle it).
 */
export function checkReadRangeOverlap(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  currentFsVersion: number,
): OverlapResult {
  const key = normalizePath(filePath)
  const ranges = byPath.get(key)
  if (!ranges || ranges.length === 0) return { kind: 'not_covered' }

  // Only consider ranges captured at the same fsVersion. If the global
  // counter advanced (a write happened somewhere), prior ranges may be stale.
  const valid = ranges.filter((r) => r.fsVersion === currentFsVersion)
  if (valid.length === 0) return { kind: 'not_covered' }

  const [reqStart, reqEnd] = toInterval({ offset, limit })
  const merged = mergeIntervals(valid.map(toInterval))

  // Fully covered?
  let covered = false
  for (const [s, e] of merged) {
    if (s <= reqStart && e >= reqEnd) {
      covered = true
      break
    }
  }
  if (covered) {
    stats.skippedOverlappingReads++
    const rangeLabel =
      reqEnd === Number.POSITIVE_INFINITY
        ? `${reqStart}-EOF`
        : `${reqStart}-${reqEnd}`
    return {
      kind: 'fully_covered',
      stub:
        `Range already covered by previous read_file: ${filePath}:${rangeLabel}. ` +
        `The content you previously read for these lines is still current. ` +
        `Use your existing knowledge; do not re-read this range.`,
    }
  }

  // Partially covered — find the first missing sub-range.
  const gap = firstUncovered(merged, reqStart, reqEnd)
  if (gap) {
    stats.adjustedReadRanges++
    const [gapStart, gapEnd] = gap
    const adjustedOffset = gapStart
    const adjustedLimit =
      gapEnd === Number.POSITIVE_INFINITY ? undefined : gapEnd - gapStart + 1
    return {
      kind: 'partially_covered',
      adjustedRange: { offset: adjustedOffset, limit: adjustedLimit },
    }
  }

  // firstUncovered returned null but we didn't flag fully_covered above —
  // can happen when intervals exactly touch. Treat as covered.
  stats.skippedOverlappingReads++
  return {
    kind: 'fully_covered',
    stub: `Range already covered by previous read_file: ${filePath}:${reqStart}-${
      reqEnd === Number.POSITIVE_INFINITY ? 'EOF' : reqEnd
    }. The content you previously read for these lines is still current.`,
  }
}

/**
 * Record a range that was just read. Called AFTER a successful read_file
 * (the content is now in the model's context). Safe to call multiple times
 * for the same path — the tracker accumulates ranges.
 */
export function recordReadRange(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  fsVersion: number,
): void {
  const key = normalizePath(filePath)
  const ranges = byPath.get(key) ?? []
  // Avoid storing exact-duplicate ranges (the exact dedup path already
  // handled those; no need to bloat the list).
  const start = Math.max(1, offset ?? 1)
  const exists = ranges.some(
    (r) => r.offset === start && r.limit === limit && r.fsVersion === fsVersion,
  )
  if (!exists) {
    ranges.push({ offset: start, limit, fsVersion })
    byPath.set(key, ranges)
  }
}

/** Read + reset the overlap stats for this turn's request-usage export. */
export function getAndResetOverlapStats(): OverlapStats {
  const out = stats
  stats = { skippedOverlappingReads: 0, adjustedReadRanges: 0 }
  return out
}

/** All recorded ranges, for the `readRanges` export field. Returns a shallow
 *  copy so the caller can't mutate internal state. */
export function getReadRanges(): Array<{ path: string; offset?: number; limit?: number }> {
  const out: Array<{ path: string; offset?: number; limit?: number }> = []
  for (const [path, ranges] of byPath) {
    for (const r of ranges) {
      out.push({ path, offset: r.offset, limit: r.limit })
    }
  }
  return out
}

/** Clear all tracked ranges and stats. Called on resetSessionState(). */
export function clearReadRangeTracker(): void {
  byPath.clear()
  stats = { skippedOverlappingReads: 0, adjustedReadRanges: 0 }
}
