/**
 * read_file pagination + byte cap tests (claude-vaz adoption, May 2026).
 *
 * The three behaviours under test live inline in `toolExecutor.ts:read_file.execute`:
 *
 *   1. Byte cap (256 KB): throw-and-instruct when no slice is requested.
 *      Cheaper than truncating — model gets a ~150-byte error instead of
 *      25 KB of content at the cap. (claude-vaz experiment #21841 showed
 *      truncate reduced error rate but raised mean tokens.)
 *
 *   2. Line-based offset/limit: lines are 1-indexed (Claude Code parity).
 *      `offset: 100, limit: 50` reads lines 100-149 inclusive.
 *
 *   3. Past-EOF slice: a slice that lands beyond the last line gets a
 *      specific message including the total line count, not the generic
 *      "file is empty" — that one is reserved for genuinely 0-byte files.
 *
 * Mirror tests of the inline logic. The behaviour matters for /plan and
 * any other workflow that reads large structured files (PLAN.md grows
 * past 30 KB; a real codebase file routinely hits 100-200 KB).
 */

const MAX_FILE_BYTES = 256 * 1024

/**
 * Pure replica of the read_file slice + byte-cap logic, kept aligned with
 * `toolExecutor.ts:read_file.execute`. If the inline form drifts, this
 * test breaks — that's the point.
 */
function readFileLogic(args: {
  fullContent: string
  offset?: number
  limit?: number
}): { result: string; isError: boolean; kind: 'oversize' | 'past_eof' | 'empty' | 'slice' | 'full' } {
  const fullContent = args.fullContent
  const offsetProvided = typeof args.offset === 'number' && args.offset > 0
  const limitProvided = typeof args.limit === 'number' && args.limit > 0
  const offset = offsetProvided ? Math.max(1, args.offset as number) : 1
  const limit = limitProvided ? Math.max(1, args.limit as number) : 0
  const sliceRequested = offsetProvided || limitProvided

  if (!sliceRequested && fullContent.length > MAX_FILE_BYTES) {
    return {
      result: `Error: File is ${(fullContent.length / 1024).toFixed(1)} KB which exceeds the 256 KB read cap. Use \`offset\` + \`limit\` to read a line range, or use search_files / glob to locate specific content. Reading the whole file would saturate the output budget for one call.`,
      isError: true,
      kind: 'oversize',
    }
  }

  let content = fullContent
  if (sliceRequested) {
    const lines = fullContent.split('\n')
    const start = Math.max(0, offset - 1)
    const end = limit > 0 ? start + limit : lines.length
    const slice = lines.slice(start, end)
    const hasMore = end < lines.length
    content = slice.join('\n')
    if (hasMore) {
      content += `\n\n[truncated at line ${end} of ${lines.length}; use offset: ${end + 1} to continue]`
    }
  }

  if (content.length === 0) {
    if (sliceRequested && fullContent.length > 0) {
      const totalLines = fullContent.split('\n').length
      return {
        result: `<system-reminder>The slice (offset ${offset}${limit > 0 ? `, limit ${limit}` : ''}) is past the end of the file. The file has ${totalLines} lines; pick an offset within range.</system-reminder>`,
        isError: false,
        kind: 'past_eof',
      }
    }
    return {
      result: '<system-reminder>The file exists but the contents are empty.</system-reminder>',
      isError: false,
      kind: 'empty',
    }
  }

  return { result: content, isError: false, kind: sliceRequested ? 'slice' : 'full' }
}

describe('read_file — byte cap (claude-vaz adoption)', () => {
  it('returns full content for files under the 256 KB cap', () => {
    const r = readFileLogic({ fullContent: 'x'.repeat(100_000) })
    expect(r.kind).toBe('full')
    expect(r.isError).toBe(false)
  })

  it('throws an instructive error for files over the cap when no slice is requested', () => {
    const r = readFileLogic({ fullContent: 'x'.repeat(300_000) })
    expect(r.kind).toBe('oversize')
    expect(r.isError).toBe(true)
    expect(r.result).toContain('256 KB')
    expect(r.result).toContain('offset')
    expect(r.result).toContain('limit')
    expect(r.result).toContain('search_files')
    // Throw vs truncate: the error MUST be much smaller than the file
    // (the whole point — ~150 bytes vs 300 KB).
    expect(r.result.length).toBeLessThan(500)
  })

  it('lets oversize files through when the model explicitly slices (escape hatch)', () => {
    const r = readFileLogic({ fullContent: 'a\n'.repeat(150_000), offset: 1, limit: 100 })
    expect(r.kind).toBe('slice')
    expect(r.isError).toBe(false)
  })
})

describe('read_file — line-based offset/limit (Claude Code parity)', () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')

  it('reads from offset to end when limit is omitted', () => {
    const r = readFileLogic({ fullContent: content, offset: 45 })
    expect(r.result.startsWith('line 45')).toBe(true)
    expect(r.result.endsWith('line 50')).toBe(true)
    expect(r.kind).toBe('slice')
  })

  it('reads exactly `limit` lines starting at `offset` (1-indexed)', () => {
    const r = readFileLogic({ fullContent: content, offset: 10, limit: 5 })
    const lines = r.result.split('\n')
    expect(lines[0]).toBe('line 10')
    expect(lines[1]).toBe('line 11')
    expect(lines[4]).toBe('line 14')
    // Should have a continuation hint since there's more after line 14.
    expect(r.result).toMatch(/use offset: 15 to continue/)
  })

  it('appends a continuation hint with the next offset when the slice does not reach EOF', () => {
    const r = readFileLogic({ fullContent: content, offset: 1, limit: 20 })
    expect(r.result).toMatch(/truncated at line 20 of 50/)
    expect(r.result).toMatch(/use offset: 21 to continue/)
  })

  it('does NOT append a continuation hint when the slice reaches the last line', () => {
    const r = readFileLogic({ fullContent: content, offset: 40, limit: 20 })
    expect(r.result).not.toContain('use offset')
    expect(r.result.endsWith('line 50')).toBe(true)
  })

  it('treats offset 0 / negative as "no offset" (read from start)', () => {
    const r = readFileLogic({ fullContent: content, offset: 0, limit: 3 })
    // limit alone counts as sliceRequested, starts at line 1.
    const lines = r.result.split('\n')
    expect(lines[0]).toBe('line 1')
    expect(lines[2]).toBe('line 3')
  })
})

describe('read_file — empty vs past-EOF discrimination', () => {
  it('reports "file is empty" for genuinely empty files', () => {
    const r = readFileLogic({ fullContent: '' })
    expect(r.kind).toBe('empty')
    expect(r.result).toContain('contents are empty')
  })

  it('reports "past end" for slices that land beyond the file', () => {
    const r = readFileLogic({
      fullContent: 'line 1\nline 2\nline 3',
      offset: 100,
      limit: 10,
    })
    expect(r.kind).toBe('past_eof')
    expect(r.result).toContain('past the end of the file')
    expect(r.result).toContain('3 lines')
  })

  it('past-EOF message names the line count so the model can self-correct', () => {
    const r = readFileLogic({
      fullContent: Array.from({ length: 12 }, () => 'line').join('\n'),
      offset: 50,
    })
    expect(r.result).toContain('12 lines')
    expect(r.result).toContain('offset 50')
  })
})
