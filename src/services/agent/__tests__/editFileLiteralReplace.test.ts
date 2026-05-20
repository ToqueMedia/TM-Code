/**
 * edit_file regression tests for the three bugs identified after the
 * Opus 4.7 /plan PLAN.md loop (May 2026 session for "todo-mimo"). The
 * helpers under test are exported from `editLiteralReplace.ts` and used
 * verbatim by `toolExecutor.ts` / `agentService.ts` — no mirror copies,
 * no drift risk.
 *
 *   Bug #1 — editFileReplace: literal substring replace, no $-sequence
 *            interpretation. A new_str containing the email-regex `^...$`
 *            followed by a backtick (`$\``) used to expand as "insert
 *            string-before-match" under String.prototype.replace.
 *
 *   Bug #2 — duplicateMatchError: multi-option message listing both
 *            "add more context" AND "re-read + write_file overwrite".
 *
 *   Bug #3 — sanitizeDiffForModel: collapse diff JSON (44KB+) to a
 *            one-line "File updated: <path>" summary for the next API
 *            turn's tool_result.
 */

import {
  editFileReplace,
  duplicateMatchError,
  sanitizeDiffForModel,
} from '../editLiteralReplace'

// Alias kept for test readability; the implementation lives in
// editLiteralReplace.ts and is shared with production.
const sanitizeForModel = sanitizeDiffForModel

/**
 * Mirror of the field-name normalization logic in the edit_file handler.
 * Production lives inline at `toolExecutor.ts:edit_file.execute`. The May
 * 2026 todo-mimo /plan loop fired because the schema declared
 * `old_str`/`new_str` while the model defaulted to `old_string`/`new_string`
 * (Claude Code's Edit tool convention — the names it knows from training).
 * Resolution: align with Claude Code — only `old_string`/`new_string` are
 * accepted now; any misnamed key triggers a key-aware diagnostic error
 * instead of a generic "cannot be empty".
 */
interface EditFileInput {
  file_path?: string
  old_string?: string
  new_string?: string
  // Common wrong names the diagnostic detects:
  old_str?: string
  new_str?: string
  oldStr?: string
  oldString?: string
  old_text?: string
  [k: string]: unknown
}

function normalizeEditFileInput(input: EditFileInput): { oldStr: string; newStr: string; error: string | null } {
  const oldStr = (input.old_string ?? '') as string
  const newStr = (input.new_string ?? '') as string
  if (oldStr) return { oldStr, newStr, error: null }
  const passedKeys = Object.keys(input).filter(k => !k.startsWith('_'))
  const wrongName = passedKeys.find(k =>
    k === 'oldStr' || k === 'oldString' || k === 'old_text' ||
    k === 'old_str' || k === 'new_str',
  )
  if (wrongName) {
    return {
      oldStr: '',
      newStr: '',
      error: `Error: this tool expects \`old_string\` (and \`new_string\`). You passed: ${passedKeys.join(', ')}. Rename your field to old_string / new_string and retry.`,
    }
  }
  return {
    oldStr: '',
    newStr: '',
    error: 'Error: old_string cannot be empty. Provide the exact text you want to replace.',
  }
}

describe('Bug #4: edit_file uses old_string/new_string (Claude Code convention)', () => {
  // Regression context — todo-mimo /plan session, May 2026:
  //   Schema declared `old_str`/`new_str`. Model defaulted to
  //   `old_string`/`new_string` (Claude Code naming — what its training
  //   prefers). Tool read `input.old_str` (undefined), returned
  //   "old_str cannot be empty", model retried with same wrong key. Loop.
  //   Resolution: align schema with Claude Code. The legacy aliases are
  //   removed — strict canonical only, with a key-aware diagnostic when
  //   the model passes a wrong name.

  it('accepts the canonical names (old_string + new_string)', () => {
    const { oldStr, newStr, error } = normalizeEditFileInput({
      file_path: '/x',
      old_string: 'foo',
      new_string: 'bar',
    })
    expect(error).toBeNull()
    expect(oldStr).toBe('foo')
    expect(newStr).toBe('bar')
  })

  it('REJECTS the legacy alias names (old_str + new_str) with key-aware diagnostic', () => {
    // Aliases removed. Anyone still passing old_str/new_str gets the
    // typo-aware error pointing them at the canonical names.
    const { oldStr, error } = normalizeEditFileInput({
      file_path: '/x',
      old_str: 'foo',
      new_str: 'bar',
    } as EditFileInput)
    expect(oldStr).toBe('')
    expect(error).toMatch(/this tool expects `old_string`/)
    expect(error).toContain('old_str')
  })

  it('returns a key-aware diagnostic for camelCase typos (oldString, oldStr)', () => {
    const { error } = normalizeEditFileInput({
      file_path: '/x',
      oldString: 'foo',  // missing underscore
      new_string: 'bar',
    } as EditFileInput)
    expect(error).toMatch(/this tool expects `old_string`/)
    expect(error).toContain('oldString')
    expect(error).toContain('Rename your field')
  })

  it('returns a key-aware diagnostic for the old_text editor convention', () => {
    const { error } = normalizeEditFileInput({
      file_path: '/x',
      old_text: 'foo',
      new_string: 'bar',
    } as EditFileInput)
    expect(error).toMatch(/this tool expects `old_string`/)
    expect(error).toContain('old_text')
  })

  it('returns a generic "empty" error only when NO recognised wrong name is present', () => {
    const { error } = normalizeEditFileInput({ file_path: '/x' })
    expect(error).toMatch(/old_string cannot be empty/)
    expect(error).not.toMatch(/this tool expects/)
  })

  it('does NOT leak internal flags (_toolCallId, _abortSignal) into the error key list', () => {
    const { error } = normalizeEditFileInput({
      file_path: '/x',
      _toolCallId: 'tc_1',
      _abortSignal: {} as never,
      oldString: 'foo',
    } as EditFileInput)
    expect(error).not.toContain('_toolCallId')
    expect(error).not.toContain('_abortSignal')
  })
})

describe('Bug #1: edit_file does literal substring replacement', () => {
  // Sanity baseline — String.prototype.replace WOULD corrupt this. Documenting
  // the contrast so a future reader sees why the bug exists. The corruption
  // shape: `$\`` (dollar + backtick) inside new_str expands to the
  // "string-before-match" portion of content. In production this is what
  // smuggled the file's frontmatter into the middle of the validation table.
  it('demonstrates the bug exists in String.prototype.replace (baseline)', () => {
    const content = '# Header\n## 8. Section\n_In progress._\n'
    const newStr = '## 8. Section\nregex `^x+$`\n'
    const broken = content.replace('## 8. Section\n_In progress._\n', newStr)
    // The regex backtick gets prefixed with the entire pre-match content
    // ("# Header\n"), turning `regex \`^x+$\`` into a corrupted hybrid where
    // "# Header" leaks INSIDE the regex literal.
    expect(broken).toContain('regex `^x+# Header')
    // And the literal new_str the model wrote is no longer recoverable from
    // the file as-is — exactly the failure mode that broke /plan PLAN.md.
    expect(broken).not.toContain('regex `^x+$`')
  })

  it('writes new_str literally when it contains "$`" (the actual PLAN.md corruption pattern)', () => {
    const content = '# Architecture: Auth\n\n> Status: DRAFT\n\n## 8. Validation\n_In progress._\n'
    const newStr = '## 8. Validation\n| `email` | regex `^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$` | done |\n'
    const out = editFileReplace(content, '## 8. Validation\n_In progress._\n', newStr)
    expect(out).toContain('regex `^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$`')
    // The smoking gun: the broken version would have inserted the file's
    // pre-match prefix (everything before "## 8. Validation"), producing a
    // SECOND "> Status: DRAFT" line. Assert only one survives.
    const draftCount = out.split('> Status: DRAFT').length - 1
    expect(draftCount).toBe(1)
  })

  it('writes new_str literally when it contains "$$" (would otherwise collapse to single $)', () => {
    const out = editFileReplace('placeholder', 'placeholder', 'Price: $$10 USD')
    expect(out).toBe('Price: $$10 USD')
  })

  it('writes new_str literally when it contains "$&" (would otherwise inject the matched substring)', () => {
    const out = editFileReplace('placeholder', 'placeholder', 'shell: echo $& done')
    expect(out).toBe('shell: echo $& done')
    expect(out).not.toContain('echo placeholder done')
  })

  it("writes new_str literally when it contains \"$'\" (would otherwise inject the suffix)", () => {
    const out = editFileReplace('placeholder', 'placeholder', "perl: $' end-of-match")
    expect(out).toBe("perl: $' end-of-match")
  })

  it('writes new_str literally when it contains "$1" (would otherwise be empty for non-regex match)', () => {
    const out = editFileReplace('placeholder', 'placeholder', 'capture group $1 here')
    expect(out).toBe('capture group $1 here')
  })

  it('throws when oldStr is not in content (defensive invariant)', () => {
    // Production guards against this with `occurrences > 0` upstream of
    // the call. The throw is defensive — if the upstream check ever drifts
    // the failure stays loud instead of silently writing garbage.
    expect(() => editFileReplace('hello world', 'missing', 'X'))
      .toThrow(/uniqueness check upstream is broken/)
  })

  it('preserves byte-perfect identity for arbitrary $ patterns mixed in markdown', () => {
    const tricky = [
      'Line 1 with $`',
      "Line 2 with $'",
      'Line 3 with $$ and $& and $1 and $<name>',
      'Line 4 ends in regex `^x+$`',
    ].join('\n')
    const out = editFileReplace('XX placeholder XX', 'placeholder', tricky)
    expect(out).toBe(`XX ${tricky} XX`)
  })
})

describe('Bug #2: improved error message on non-unique old_string', () => {
  it('mentions both the "add context" path AND the "write_file overwrite" recovery path', () => {
    const msg = duplicateMatchError('/proj/PLAN.md', 2)
    expect(msg).toMatch(/appears 2 times/)
    // Old behaviour: only mentioned "include more surrounding context".
    // New behaviour: explicit two-option recovery.
    expect(msg.toLowerCase()).toContain('surrounding context')
    expect(msg.toLowerCase()).toContain('write_file')
    expect(msg.toLowerCase()).toContain('corrupted')
    // References to the canonical schema names, not the removed legacy alias.
    expect(msg).toContain('old_string/new_string')
  })

  it('discourages chasing the duplicate with more edits', () => {
    const msg = duplicateMatchError('/proj/PLAN.md', 2)
    expect(msg.toLowerCase()).toContain('do not chase the duplicate')
  })
})

describe('Bug #3: diff JSON sanitization for the model tool_result', () => {
  it('collapses a 44KB diff JSON down to a single one-line summary', () => {
    const bigFile = 'x'.repeat(44_000)
    const diffJson = JSON.stringify({
      type: 'diff',
      path: '/proj/PLAN.md',
      oldContent: bigFile,
      newContent: bigFile + ' edited',
      isNewFile: false,
    })
    const out = sanitizeForModel(diffJson)
    expect(out).toBe('File updated: /proj/PLAN.md')
    // The whole point — bytes shipped to the model drop by ~3 orders of magnitude.
    expect(out.length).toBeLessThan(diffJson.length / 1000)
  })

  it('marks isNewFile diffs as "created" rather than "updated"', () => {
    const diffJson = JSON.stringify({
      type: 'diff',
      path: '/proj/new.ts',
      oldContent: '',
      newContent: 'export const x = 1',
      isNewFile: true,
    })
    expect(sanitizeForModel(diffJson)).toBe('File created: /proj/new.ts')
  })

  it('passes non-JSON tool results through untouched (search hits, file reads, etc.)', () => {
    const searchResult = 'src/foo.ts:42: const bar = 1'
    expect(sanitizeForModel(searchResult)).toBe(searchResult)
  })

  it('passes JSON tool results that are not diffs through untouched', () => {
    const otherJson = JSON.stringify({ type: 'metrics', count: 5 })
    expect(sanitizeForModel(otherJson)).toBe(otherJson)
  })

  it('passes diff-shaped JSON missing the path field through untouched (defensive)', () => {
    const malformed = JSON.stringify({ type: 'diff', oldContent: 'a', newContent: 'b' })
    expect(sanitizeForModel(malformed)).toBe(malformed)
  })
})
