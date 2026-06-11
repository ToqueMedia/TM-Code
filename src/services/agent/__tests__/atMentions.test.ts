/**
 * atMentions tests — the claude-vaz parity port for @-mention resolution.
 *
 * Covers: extraction (quoted paths, line ranges, agent-mention skip),
 * line-range parsing, synthetic tool-pair rendering, already-in-context
 * omission, oversize truncation fallback + meta note, silent drops
 * (denied / missing / binary), directory listings, the changed-file
 * reminder rendering, and applyMentionResolution shapes.
 *
 * ToolExecutor and the Tauri fs plugin are mocked — the engine's contract
 * with them is exactly the public mention surface added to the executor.
 */

const mockExecutor = {
  resolveMentionPath: jest.fn((p: string) => (p.startsWith('/') ? p : `/proj/${p}`)),
  isMentionPathAllowed: jest.fn(() => true),
  isFileFreshInContext: jest.fn(() => false),
  executeForMention: jest.fn<Promise<string>, [string, Record<string, unknown>]>(async () => 'file contents'),
  collectExternallyChangedFiles: jest.fn(async () => [] as Array<{ path: string; snippet: string }>),
}

jest.mock('../toolExecutor', () => ({
  __esModule: true,
  default: { getInstance: () => mockExecutor },
}))

jest.mock('../../attachmentService', () => ({
  __esModule: true,
  resolveImageToDataUri: jest.fn(async () => 'data:image/png;base64,FAKE'),
}))

const mockStat = jest.fn(async (): Promise<{ isDirectory: boolean }> => ({ isDirectory: false }))
jest.mock('@tauri-apps/plugin-fs', () => ({
  __esModule: true,
  stat: () => mockStat(),
}))

import {
  extractAtMentionedFiles,
  parseAtMentionedFileLines,
  resolveMentionContext,
  collectChangedFileContext,
  applyMentionResolution,
  wrapInSystemReminder,
  MAX_LINES_TO_READ,
} from '../atMentions'
import { FILE_UNCHANGED_STUB } from '../toolExecutor/readDedup'

beforeEach(() => {
  jest.clearAllMocks()
  mockExecutor.resolveMentionPath.mockImplementation((p: string) => (p.startsWith('/') ? p : `/proj/${p}`))
  mockExecutor.isMentionPathAllowed.mockReturnValue(true)
  mockExecutor.isFileFreshInContext.mockReturnValue(false)
  mockExecutor.executeForMention.mockResolvedValue('file contents')
  mockExecutor.collectExternallyChangedFiles.mockResolvedValue([])
  mockStat.mockResolvedValue({ isDirectory: false })
})

describe('extractAtMentionedFiles (claude-vaz port)', () => {
  it('extracts simple mentions', () => {
    expect(extractAtMentionedFiles('fix @src/foo.ts please')).toEqual(['src/foo.ts'])
  })

  it('extracts quoted paths with spaces', () => {
    expect(extractAtMentionedFiles('check @"my dir/the file.ts" now')).toEqual(['my dir/the file.ts'])
  })

  it('skips agent mentions in quoted form', () => {
    expect(extractAtMentionedFiles('ask @"code-reviewer (agent)" to look')).toEqual([])
  })

  it('does not match mid-word @ (emails)', () => {
    expect(extractAtMentionedFiles('mail user@host.com today')).toEqual([])
  })

  it('keeps the line-range fragment on the token', () => {
    expect(extractAtMentionedFiles('see @src/a.ts#L10-20')).toEqual(['src/a.ts#L10-20'])
  })

  it('drops trailing punctuation via the word boundary', () => {
    expect(extractAtMentionedFiles('look at @src/foo.ts.')).toEqual(['src/foo.ts'])
  })

  it('deduplicates repeated mentions', () => {
    expect(extractAtMentionedFiles('@a.ts and @a.ts again')).toEqual(['a.ts'])
  })
})

describe('parseAtMentionedFileLines (claude-vaz port)', () => {
  it('parses plain filenames', () => {
    expect(parseAtMentionedFileLines('src/a.ts')).toEqual({ filename: 'src/a.ts', lineStart: undefined, lineEnd: undefined })
  })

  it('parses a single line', () => {
    expect(parseAtMentionedFileLines('a.ts#L10')).toEqual({ filename: 'a.ts', lineStart: 10, lineEnd: 10 })
  })

  it('parses a line range', () => {
    expect(parseAtMentionedFileLines('a.ts#L10-20')).toEqual({ filename: 'a.ts', lineStart: 10, lineEnd: 20 })
  })

  it('strips non-line-range fragments', () => {
    expect(parseAtMentionedFileLines('README.md#installation')).toEqual({ filename: 'README.md', lineStart: undefined, lineEnd: undefined })
  })
})

describe('resolveMentionContext', () => {
  it('returns empty for input without mentions', async () => {
    const r = await resolveMentionContext('no mentions here')
    expect(r.contextText).toBe('')
    expect(r.imageParts).toEqual([])
    expect(mockExecutor.executeForMention).not.toHaveBeenCalled()
  })

  it('skips slash-command input entirely', async () => {
    const r = await resolveMentionContext('/plan something with @src/a.ts')
    expect(r.contextText).toBe('')
    expect(mockExecutor.executeForMention).not.toHaveBeenCalled()
  })

  it('renders the synthetic read_file pair in system-reminder blocks', async () => {
    mockExecutor.executeForMention.mockResolvedValue('const x = 1\n')
    const r = await resolveMentionContext('explain @src/a.ts')

    expect(mockExecutor.executeForMention).toHaveBeenCalledWith('read_file', { file_path: '/proj/src/a.ts' })
    expect(r.contextText).toContain('<system-reminder>')
    expect(r.contextText).toContain('Called the read_file tool with the following input: {"file_path":"/proj/src/a.ts"}')
    expect(r.contextText).toContain('Result of calling the read_file tool:\nconst x = 1')
  })

  it('passes line ranges as offset/limit', async () => {
    await resolveMentionContext('check @src/a.ts#L10-20')
    expect(mockExecutor.executeForMention).toHaveBeenCalledWith('read_file', {
      file_path: '/proj/src/a.ts', offset: 10, limit: 11,
    })
  })

  it('omits files already fresh in context (already_read_file parity)', async () => {
    mockExecutor.isFileFreshInContext.mockReturnValue(true)
    const r = await resolveMentionContext('see @src/a.ts')
    expect(r.contextText).toBe('')
    expect(mockExecutor.executeForMention).not.toHaveBeenCalled()
  })

  it('still reads when a line range is requested even if fresh in context', async () => {
    mockExecutor.isFileFreshInContext.mockReturnValue(true)
    await resolveMentionContext('see @src/a.ts#L5')
    expect(mockExecutor.executeForMention).toHaveBeenCalled()
  })

  it('renders nothing when the tool returns the unchanged-file stub', async () => {
    mockExecutor.executeForMention.mockResolvedValue(FILE_UNCHANGED_STUB)
    const r = await resolveMentionContext('see @src/a.ts')
    expect(r.contextText).toBe('')
  })

  it('drops missing files silently', async () => {
    mockExecutor.executeForMention.mockResolvedValue('File not found: /proj/nope.ts\nNote: your current working directory is /proj')
    const r = await resolveMentionContext('see @nope.ts')
    expect(r.contextText).toBe('')
  })

  it('drops out-of-scope paths silently (deny-rule parity)', async () => {
    mockExecutor.isMentionPathAllowed.mockReturnValue(false)
    const r = await resolveMentionContext('see @../../etc/passwd')
    expect(r.contextText).toBe('')
    expect(mockExecutor.executeForMention).not.toHaveBeenCalled()
  })

  it('drops binary extensions silently', async () => {
    const r = await resolveMentionContext('see @dist/app.zip')
    expect(r.contextText).toBe('')
    expect(mockExecutor.executeForMention).not.toHaveBeenCalled()
  })

  it('falls back to a truncated read + meta note for oversized files', async () => {
    mockExecutor.executeForMention
      .mockResolvedValueOnce('Error: File is 1024.0 KB which exceeds the 256 KB read cap. Use `offset` + `limit` to read a line range, or use search_files / glob to locate specific content.')
      .mockResolvedValueOnce('line1\nline2')
    const r = await resolveMentionContext('see @big.ts')

    expect(mockExecutor.executeForMention).toHaveBeenNthCalledWith(2, 'read_file', {
      file_path: '/proj/big.ts', offset: 1, limit: MAX_LINES_TO_READ,
    })
    expect(r.contextText).toContain(`truncated to the first ${MAX_LINES_TO_READ} lines`)
    expect(r.contextText).toContain("Don't tell the user about this truncation")
    expect(r.contextText).toContain('Result of calling the read_file tool:\nline1\nline2')
  })

  it('renders directories as a synthetic list_directory pair', async () => {
    mockStat.mockResolvedValue({ isDirectory: true })
    mockExecutor.executeForMention.mockResolvedValue('[d] components\n    index.ts')
    const r = await resolveMentionContext('explore @src/')

    expect(mockExecutor.executeForMention).toHaveBeenCalledWith('list_directory', {
      file_path: '/proj/src', maxDepth: 1,
    })
    expect(r.contextText).toContain('Called the list_directory tool with the following input:')
    expect(r.contextText).toContain('Result of calling the list_directory tool:')
  })

  it('resolves image mentions into image parts with a tool-call reminder', async () => {
    const r = await resolveMentionContext('look at @design/mock.png')
    expect(r.contextText).toBe('')
    expect(r.imageParts).toHaveLength(1)
    expect(r.imageParts[0].dataUri).toBe('data:image/png;base64,FAKE')
    expect(r.imageParts[0].reminder).toContain('Called the read_file tool')
  })

  it('drops a mention whose execution throws (path scope / .env)', async () => {
    mockExecutor.executeForMention.mockRejectedValue(new Error('.env files are blocked'))
    const r = await resolveMentionContext('see @.env.local')
    expect(r.contextText).toBe('')
  })

  it('preserves mention order across multiple files', async () => {
    mockExecutor.executeForMention
      .mockImplementation(async (_tool: string, input: Record<string, unknown>) => `contents of ${input.file_path}`)
    const r = await resolveMentionContext('compare @a.ts and @b.ts')
    const idxA = r.contextText.indexOf('contents of /proj/a.ts')
    const idxB = r.contextText.indexOf('contents of /proj/b.ts')
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxB).toBeGreaterThan(idxA)
  })
})

describe('collectChangedFileContext', () => {
  it('returns empty when nothing changed', async () => {
    expect(await collectChangedFileContext()).toBe('')
  })

  it('renders the claude-vaz edited_text_file note per changed file', async () => {
    mockExecutor.collectExternallyChangedFiles.mockResolvedValue([
      { path: '/proj/src/a.ts', snippet: '     1→const x = 2' },
    ])
    const ctx = await collectChangedFileContext()
    expect(ctx).toContain('<system-reminder>')
    expect(ctx).toContain('Note: /proj/src/a.ts was modified, either by the user or by a linter.')
    expect(ctx).toContain("don't revert it unless the user asks you to")
    expect(ctx).toContain('     1→const x = 2')
  })

  it('never throws — sweep failures return empty', async () => {
    mockExecutor.collectExternallyChangedFiles.mockRejectedValue(new Error('boom'))
    expect(await collectChangedFileContext()).toBe('')
  })
})

describe('applyMentionResolution', () => {
  it('appends the context after a string prompt (claude-vaz ordering)', () => {
    const applied = applyMentionResolution(
      'fix the bug',
      { contextText: wrapInSystemReminder('ctx'), imageParts: [] },
      '',
      true,
    )
    expect(applied.userContent).toBe(`fix the bug\n${wrapInSystemReminder('ctx')}`)
    expect(applied.persistedContext).toBe(wrapInSystemReminder('ctx'))
  })

  it('appends a text part to content-part arrays', () => {
    const applied = applyMentionResolution(
      [{ type: 'text', text: 'prompt' }],
      { contextText: 'CTX', imageParts: [] },
      '',
      true,
    )
    expect(Array.isArray(applied.userContent)).toBe(true)
    const parts = applied.userContent as Array<{ type: string; text?: string }>
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'CTX' })
  })

  it('promotes string content to parts when image mentions exist on multimodal plans', () => {
    const applied = applyMentionResolution(
      'see this',
      { contextText: '', imageParts: [{ reminder: 'R', dataUri: 'data:x', displayPath: '/p.png' }] },
      '',
      true,
    )
    const parts = applied.userContent as Array<{ type: string }>
    expect(parts.map(p => p.type)).toEqual(['text', 'text', 'image_url'])
  })

  it('degrades image mentions to a text note on text-only plans', () => {
    const applied = applyMentionResolution(
      'see this',
      { contextText: '', imageParts: [{ reminder: 'R', dataUri: 'data:x', displayPath: '/p.png' }] },
      '',
      false,
    )
    expect(typeof applied.userContent).toBe('string')
    expect(applied.userContent).toContain('text-only')
    expect(applied.persistedContext).toContain('text-only')
  })

  it('joins mention context and changed-file context in order', () => {
    const applied = applyMentionResolution(
      'prompt',
      { contextText: 'MENTIONS', imageParts: [] },
      'CHANGED',
      true,
    )
    expect(applied.userContent).toBe('prompt\nMENTIONS\nCHANGED')
  })

  it('is a no-op when there is nothing to apply', () => {
    const applied = applyMentionResolution('prompt', { contextText: '', imageParts: [] }, '', true)
    expect(applied.userContent).toBe('prompt')
    expect(applied.persistedContext).toBe('')
  })
})
