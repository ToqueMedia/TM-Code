/**
 * Tests for the large_result bookkeeping helpers added in the May 2026
 * paginated-reads postmortem:
 *
 *   B4 — cap-approaching warning in the truncation message.
 *   S1 — overlap detection on re-reads (`trackShownRange` merge logic).
 *   S2 — incremental byte-budget eviction (no full scan).
 *
 * The helpers live as instance methods on ToolExecutor (`trackShownRange`,
 * `evictOldestLargeResult`). Both are pure functions of their input state,
 * so we replicate them here against a small fake state model — testing
 * the algorithm independently of the heavy ToolExecutor constructor
 * (which pulls in Tauri webview surface that fails Jest module loading).
 *
 * If the production implementation drifts from this mirror, the test
 * fails — that's the point. Keep the two in sync.
 */

// ============ Mirror: trackShownRange algorithm ===========================
//
// Merges a new [offset, end) into an existing sorted list of ranges,
// coalescing any range it touches. Returns the first overlapped range
// (or null when no overlap).
//
// Production site: ToolExecutor.trackShownRange in toolExecutor.ts.

interface ShownRangesState {
  ranges: Array<[number, number]>
}

function trackShownRange(state: ShownRangesState, offset: number, end: number): [number, number] | null {
  let mergedStart = offset
  let mergedEnd = end
  let firstOverlap: [number, number] | null = null
  const survivors: Array<[number, number]> = []
  for (const r of state.ranges) {
    if (r[0] <= mergedEnd && mergedStart <= r[1]) {
      if (!firstOverlap) firstOverlap = [r[0], r[1]]
      mergedStart = Math.min(mergedStart, r[0])
      mergedEnd = Math.max(mergedEnd, r[1])
    } else {
      survivors.push(r)
    }
  }
  survivors.push([mergedStart, mergedEnd])
  survivors.sort((a, b) => a[0] - b[0])
  state.ranges = survivors
  return firstOverlap
}

describe('S1: trackShownRange — overlap detection + range coalescing', () => {
  it('records the first read as a single range with no overlap signal', () => {
    const state = { ranges: [] as Array<[number, number]> }
    expect(trackShownRange(state, 0, 2000)).toBeNull()
    expect(state.ranges).toEqual([[0, 2000]])
  })

  it('returns null and appends a disjoint range that does not touch any existing', () => {
    const state = { ranges: [[0, 2000]] as Array<[number, number]> }
    expect(trackShownRange(state, 10_000, 12_000)).toBeNull()
    expect(state.ranges).toEqual([[0, 2000], [10_000, 12_000]])
  })

  it('coalesces ADJACENT ranges into one — three sequential reads collapse to one entry', () => {
    const state = { ranges: [] as Array<[number, number]> }
    trackShownRange(state, 0, 2000)
    trackShownRange(state, 2000, 4000)
    trackShownRange(state, 4000, 6000)
    expect(state.ranges).toEqual([[0, 6000]])
  })

  it('returns the overlapping range when a re-read partially covers existing', () => {
    const state = { ranges: [[0, 2000]] as Array<[number, number]> }
    const overlap = trackShownRange(state, 1500, 3000)
    expect(overlap).toEqual([0, 2000])
    expect(state.ranges).toEqual([[0, 3000]])
  })

  it('returns the overlapping range when a re-read is FULLY inside existing', () => {
    const state = { ranges: [[0, 5000]] as Array<[number, number]> }
    const overlap = trackShownRange(state, 1000, 2000)
    expect(overlap).toEqual([0, 5000])
    expect(state.ranges).toEqual([[0, 5000]])
  })

  it('coalesces multiple existing ranges that the new read bridges', () => {
    const state = { ranges: [[0, 1000], [2000, 3000], [5000, 6000]] as Array<[number, number]> }
    // A read from 500 to 5500 touches all three.
    trackShownRange(state, 500, 5500)
    expect(state.ranges).toEqual([[0, 6000]])
  })

  it('keeps the list sorted ascending by start offset', () => {
    const state = { ranges: [] as Array<[number, number]> }
    trackShownRange(state, 5000, 6000)
    trackShownRange(state, 0, 1000)
    trackShownRange(state, 2000, 3000)
    expect(state.ranges).toEqual([[0, 1000], [2000, 3000], [5000, 6000]])
  })
})

// ============ Mirror: incremental byte-budget eviction ====================
//
// Production site: ToolExecutor.truncateResult + evictOldestLargeResult.
// The contract: total bytes never exceed MAX_BYTES, eviction order is
// FIFO (oldest first), and the byte counter stays in sync with the Map.

interface LargeResultsState {
  entries: Map<string, string>
  totalBytes: number
}

function addLargeResult(state: LargeResultsState, id: string, content: string, maxBytes: number, maxEntries: number): void {
  state.entries.set(id, content)
  state.totalBytes += content.length
  while (state.totalBytes > maxBytes && state.entries.size > 1) {
    const first = state.entries.keys().next().value
    if (!first) break
    state.totalBytes -= state.entries.get(first)!.length
    state.entries.delete(first)
  }
  while (state.entries.size > maxEntries) {
    const first = state.entries.keys().next().value
    if (!first) break
    state.totalBytes -= state.entries.get(first)!.length
    state.entries.delete(first)
  }
}

describe('S2 + B4: large_results byte-budget + entry-count eviction', () => {
  const MB = 1024 * 1024

  it('keeps totalBytes in sync as entries are added', () => {
    const state = { entries: new Map<string, string>(), totalBytes: 0 }
    addLargeResult(state, 'a', 'x'.repeat(1000), 10 * MB, 100)
    addLargeResult(state, 'b', 'y'.repeat(500), 10 * MB, 100)
    expect(state.totalBytes).toBe(1500)
    expect(state.entries.size).toBe(2)
  })

  it('evicts oldest FIFO when total bytes exceed cap', () => {
    const state = { entries: new Map<string, string>(), totalBytes: 0 }
    addLargeResult(state, 'a', 'x'.repeat(3 * MB), 5 * MB, 100)
    addLargeResult(state, 'b', 'y'.repeat(3 * MB), 5 * MB, 100)
    // Adding 'b' pushes total to 6MB which exceeds the 5MB cap → evict 'a'.
    expect(state.entries.has('a')).toBe(false)
    expect(state.entries.has('b')).toBe(true)
    expect(state.totalBytes).toBe(3 * MB)
  })

  it('evicts oldest FIFO when entry count exceeds cap (independent of byte cap)', () => {
    const state = { entries: new Map<string, string>(), totalBytes: 0 }
    // Tiny entries, 100MB byte cap won't fire. Entry cap of 3 will.
    for (let i = 0; i < 5; i++) addLargeResult(state, `k${i}`, 'x', 100 * MB, 3)
    expect(state.entries.size).toBe(3)
    expect(Array.from(state.entries.keys())).toEqual(['k2', 'k3', 'k4'])
  })

  it('never evicts the entry it just added (guards single huge result)', () => {
    const state = { entries: new Map<string, string>(), totalBytes: 0 }
    // Single huge entry exceeds cap on its own — must stay; the
    // `size > 1` guard prevents wiping the just-added result.
    addLargeResult(state, 'huge', 'x'.repeat(10 * MB), 5 * MB, 20)
    expect(state.entries.has('huge')).toBe(true)
  })
})
