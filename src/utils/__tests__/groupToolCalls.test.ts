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

  it('a non-read_large_result tool_call breaks the batch', () => {
    const blocks = [
      block('tool_call', 'c1'),
      block('tool_call', 'c2'),
    ]
    const calls = new Map([
      ['c1', read('lr_4', 0, 2000, 'c1')],
      ['c2', tc({ id: 'c2', toolName: 'glob', input: { pattern: '*' } })],
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
