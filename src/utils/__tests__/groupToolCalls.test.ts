/**
 * Tests for the read_large_result UI consolidation groupers.
 *
 * Two paths in MessageBubble need batching:
 *   - The toolCalls.map fallback (older messages without contentBlocks)
 *     uses groupConsecutiveLargeReads.
 *   - The contentBlocks.map interleaved path (reasoning/text/tool_call
 *     mixed in order) uses computeContentBlockBatches.
 *
 * Both follow strict-adjacency: a reasoning/text block (or a different
 * tool / different id) breaks the batch — keeping the timeline honest.
 */

import {
  groupConsecutiveLargeReads,
  computeContentBlockBatches,
  groupExplorationRuns,
  explorationCounts,
} from '../groupToolCalls'
import type { ToolCallDisplay } from '../../types/chat'

const tc = (overrides: Partial<ToolCallDisplay> & Pick<ToolCallDisplay, 'id' | 'toolName'>): ToolCallDisplay => ({
  input: {},
  status: 'completed',
  ...overrides,
} as ToolCallDisplay)

const read = (id: string, offset: number, limit: number, callId: string): ToolCallDisplay =>
  tc({ id: callId, toolName: 'read_large_result', input: { id, offset, limit } })

describe('groupConsecutiveLargeReads — toolCalls.map path', () => {
  it('returns empty for empty input', () => {
    expect(groupConsecutiveLargeReads([])).toEqual([])
  })

  it('keeps non-read_large_result tools as singles', () => {
    const calls = [
      tc({ id: 'a', toolName: 'read_file', input: { file_path: '/x' } }),
      tc({ id: 'b', toolName: 'glob', input: { pattern: '**/*.ts' } }),
    ]
    const out = groupConsecutiveLargeReads(calls)
    expect(out).toHaveLength(2)
    expect(out.every(g => g.kind === 'single')).toBe(true)
  })

  it('batches consecutive reads of the same id', () => {
    const calls = [
      read('large_result_4', 28000, 2000, 'c1'),
      read('large_result_4', 27500, 1500, 'c2'),
      read('large_result_4', 22000, 2000, 'c3'),
    ]
    const out = groupConsecutiveLargeReads(calls)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('large_read_batch')
    if (out[0].kind === 'large_read_batch') {
      expect(out[0].id).toBe('large_result_4')
      expect(out[0].calls).toHaveLength(3)
    }
  })

  it('breaks batch when another tool sits between same-id reads', () => {
    const calls = [
      read('large_result_4', 0, 2000, 'c1'),
      tc({ id: 'g1', toolName: 'glob', input: { pattern: '*' } }),
      read('large_result_4', 2000, 2000, 'c2'),
    ]
    const out = groupConsecutiveLargeReads(calls)
    expect(out.map(g => g.kind)).toEqual(['large_read_batch', 'single', 'large_read_batch'])
  })

  it('breaks batch when consecutive reads have different ids', () => {
    const calls = [
      read('large_result_4', 0, 2000, 'c1'),
      read('large_result_5', 0, 2000, 'c2'),
    ]
    const out = groupConsecutiveLargeReads(calls)
    expect(out).toHaveLength(2)
    expect(out.every(g => g.kind === 'large_read_batch')).toBe(true)
  })

  it('treats a single read as a batch-of-one (renderer can decide UI)', () => {
    const calls = [read('large_result_4', 0, 2000, 'c1')]
    const out = groupConsecutiveLargeReads(calls)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('large_read_batch')
  })

  it('treats a read with missing id as a normal single', () => {
    const calls = [tc({ id: 'c1', toolName: 'read_large_result', input: {} })]
    const out = groupConsecutiveLargeReads(calls)
    expect(out[0].kind).toBe('single')
  })
})

describe('computeContentBlockBatches — contentBlocks.map path', () => {
  const block = (type: string, toolCallId?: string) => ({ type, toolCallId })

  it('returns all "render" directives when no read_large_result blocks', () => {
    const blocks = [block('text'), block('reasoning'), block('text')]
    const out = computeContentBlockBatches(blocks, () => undefined)
    expect(out).toHaveLength(3)
    expect(out.every(d => d.kind === 'render')).toBe(true)
  })

  it('marks start + member for consecutive same-id read blocks', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
      block('tool_call', 'c3'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', read('lr_4', 2000, 2000, 'c2')],
      ['c3', read('lr_4', 4000, 2000, 'c3')],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('batch_start')
    if (out[0].kind === 'batch_start') expect(out[0].calls).toHaveLength(3)
    expect(out[1].kind).toBe('batch_member')
    expect(out[2].kind).toBe('batch_member')
  })

  it('swallows reasoning blocks sitting between two same-id reads', () => {
    // The "(pensou 1s)" pattern the user explicitly asked to suppress:
    // per-read reasoning chunks become noise once the batch's range pills
    // tell the same story.
    const blocks = [
      block('tool_call', 'c1'),
      block('reasoning'),
      block('tool_call', 'c2'),
      block('reasoning'),
      block('tool_call', 'c3'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', read('lr_4', 2000, 2000, 'c2')],
      ['c3', read('lr_4', 4000, 2000, 'c3')],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('batch_start')
    if (out[0].kind === 'batch_start') expect(out[0].calls).toHaveLength(3)
    // All three intervening members (read + reasoning + read + reasoning) get
    // collapsed into batch_members — the row renders nothing in their place.
    expect(out[1].kind).toBe('batch_member') // reasoning swallowed
    expect(out[2].kind).toBe('batch_member') // c2 absorbed
    expect(out[3].kind).toBe('batch_member') // reasoning swallowed
    expect(out[4].kind).toBe('batch_member') // c3 absorbed
  })

  it('does NOT swallow reasoning that is followed by a non-batchable block', () => {
    // Reasoning at the tail (no same-id read after it) must render as-is —
    // the developer needs the agent's wrap-up thought.
    const blocks = [
      block('tool_call', 'c1'),
      block('reasoning'),
      block('text'),
    ]
    const calls = new Map([['c1', read('lr_4', 0, 2000, 'c1')]])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('batch_start')
    expect(out[1].kind).toBe('render') // reasoning stays
    expect(out[2].kind).toBe('render') // text stays
  })

  it('text blocks between two reads still break the batch (real prose, not noise)', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('text'),
      block('tool_call', 'c2'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', read('lr_4', 2000, 2000, 'c2')],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('batch_start')
    expect(out[1].kind).toBe('render')
    expect(out[2].kind).toBe('batch_start') // new batch
  })

  it('a non-exploration tool_call (write) breaks the batch', () => {
    // glob would now JOIN the group (it is exploration) — a write tool is
    // the boundary: approval surfaces must stay individually visible.
    const blocks = [
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', tc({ id: 'c2', toolName: 'edit_file', input: { file_path: '/x' } })],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('batch_start')
    expect(out[1].kind).toBe('render')
  })

  it('preserves length so caller .map((_, idx) => directives[idx]) is safe', () => {
    const blocks = [
      block('text'),
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
      block('reasoning'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', read('lr_4', 2000, 2000, 'c2')],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out).toHaveLength(blocks.length)
  })
})

// ─── Exploration grouping ────────────────────────────────────────────────

const readFile = (path: string, callId: string, status: ToolCallDisplay['status'] = 'completed') =>
  tc({ id: callId, toolName: 'read_file', input: { file_path: path }, status })

describe('computeContentBlockBatches — exploration groups', () => {
  const block = (type: string, toolCallId?: string) => ({ type, toolCallId })

  it('groups mixed read-only calls (read + glob + list) into exploration_start', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
      block('tool_call', 'c3'),
    ]
    const calls = new Map([
      ['c1', readFile('/p/a.ts', 'c1')],
      ['c2', tc({ id: 'c2', toolName: 'glob', input: { pattern: '**/*.ts' } })],
      ['c3', tc({ id: 'c3', toolName: 'list_directory', input: { file_path: '/p/src' } })],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('exploration_start')
    if (out[0].kind === 'exploration_start') expect(out[0].calls).toHaveLength(3)
    expect(out[1].kind).toBe('batch_member')
    expect(out[2].kind).toBe('batch_member')
  })

  it('a single plain exploration call renders normally (no group of one)', () => {
    const blocks = [block('tool_call', 'c1'), block('text')]
    const calls = new Map([['c1', readFile('/p/a.ts', 'c1')]])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('render')
  })

  it('a failed call never joins — it splits the run and pops out', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
      block('tool_call', 'c3'),
      block('tool_call', 'c4'),
    ]
    const calls = new Map([
      ['c1', readFile('/p/a.ts', 'c1')],
      ['c2', readFile('/p/b.ts', 'c2')],
      ['c3', readFile('/p/broken.ts', 'c3', 'failed')],
      ['c4', readFile('/p/c.ts', 'c4')],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('exploration_start')
    if (out[0].kind === 'exploration_start') expect(out[0].calls.map(c => c.id)).toEqual(['c1', 'c2'])
    expect(out[2].kind).toBe('render') // failed call: own red row
    expect(out[3].kind).toBe('render') // single trailing read: no group of one
  })

  it('sub-agent children (spawnedBy) never group', () => {
    const blocks = [block('tool_call', 'c1'), block('tool_call', 'c2')]
    const calls = new Map([
      ['c1', tc({ id: 'c1', toolName: 'read_file', input: { file_path: '/a' }, spawnedBy: 'parent' })],
      ['c2', tc({ id: 'c2', toolName: 'read_file', input: { file_path: '/b' }, spawnedBy: 'parent' })],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out.every(d => d.kind === 'render')).toBe(true)
  })

  it('reasoning between exploration members is swallowed only when another member follows', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('reasoning'),
      block('tool_call', 'c2'),
      block('reasoning'), // trailing thought — must render
      block('text'),
    ]
    const calls = new Map([
      ['c1', readFile('/p/a.ts', 'c1')],
      ['c2', tc({ id: 'c2', toolName: 'search_files', input: { query: 'foo' } })],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('exploration_start')
    expect(out[1].kind).toBe('batch_member') // swallowed
    expect(out[2].kind).toBe('batch_member')
    expect(out[3].kind).toBe('render') // trailing reasoning stays
    expect(out[4].kind).toBe('render')
  })

  it('a read streak plus another exploration call becomes one exploration group', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
      block('tool_call', 'c3'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', read('lr_4', 2000, 2000, 'c2')],
      ['c3', readFile('/p/a.ts', 'c3')],
    ])
    const out = computeContentBlockBatches(blocks, id => calls.get(id))
    expect(out[0].kind).toBe('exploration_start')
    if (out[0].kind === 'exploration_start') expect(out[0].calls).toHaveLength(3)
  })
})

describe('groupExplorationRuns — legacy toolCalls path', () => {
  it('groups runs with ≥2 items and leaves boundaries as singles', () => {
    const calls = [
      readFile('/p/a.ts', 'c1'),
      tc({ id: 'c2', toolName: 'glob', input: { pattern: '*' } }),
      tc({ id: 'c3', toolName: 'edit_file', input: { file_path: '/p/a.ts' } }),
      readFile('/p/b.ts', 'c4'),
    ]
    const out = groupExplorationRuns(calls)
    expect(out.map(g => g.kind)).toEqual(['exploration', 'single', 'single'])
  })

  it('a lone read streak keeps the dedicated large_read_batch rendering', () => {
    const calls = [
      read('lr_4', 0, 2000, 'c1'),
      read('lr_4', 2000, 2000, 'c2'),
    ]
    const out = groupExplorationRuns(calls)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('large_read_batch')
  })

  it('failed exploration calls stay out of groups', () => {
    const calls = [
      readFile('/p/a.ts', 'c1'),
      readFile('/p/broken.ts', 'c2', 'failed'),
      readFile('/p/b.ts', 'c3'),
    ]
    const out = groupExplorationRuns(calls)
    expect(out.map(g => g.kind)).toEqual(['single', 'single', 'single'])
  })
})

describe('explorationCounts — sentence data', () => {
  it('counts distinct file paths and keeps first-occurrence category order', () => {
    const calls = [
      tc({ id: 'c0', toolName: 'search_files', input: { query: 'foo' } }),
      readFile('/p/a.ts', 'c1'),
      readFile('/p/a.ts', 'c2'), // re-read: must not inflate
      readFile('/p/b.ts', 'c3'),
      tc({ id: 'c4', toolName: 'list_directory', input: { file_path: '/p/src' } }),
    ]
    const counts = explorationCounts(calls)
    expect(counts).toEqual([
      { category: 'searches', count: 1 },
      { category: 'files', count: 2 },
      { category: 'dirs', count: 1 },
    ])
  })

  it('folds a paginated-read streak into one output item', () => {
    const calls = [
      read('lr_4', 0, 2000, 'c1'),
      read('lr_4', 2000, 2000, 'c2'),
      readFile('/p/a.ts', 'c3'),
    ]
    const counts = explorationCounts(calls)
    expect(counts).toEqual([
      { category: 'outputs', count: 1 },
      { category: 'files', count: 1 },
    ])
  })

  it('canonicalizes claude-style aliases (Read/Grep/LS) into the same categories', () => {
    const calls = [
      tc({ id: 'c1', toolName: 'Read', input: { path: '/p/a.ts' } }),
      tc({ id: 'c2', toolName: 'Grep', input: { pattern: 'foo', path: '.' } }),
      tc({ id: 'c3', toolName: 'LS', input: { path: '/p' } }),
    ]
    const counts = explorationCounts(calls)
    expect(counts).toEqual([
      { category: 'files', count: 1 },
      { category: 'searches', count: 1 },
      { category: 'dirs', count: 1 },
    ])
  })
})
