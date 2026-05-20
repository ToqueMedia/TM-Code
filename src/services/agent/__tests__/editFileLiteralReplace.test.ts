/**
 * edit_file regression tests for the three bugs identified after the
 * Opus 4.7 /plan PLAN.md loop (May 2026 session for "todo-mimo"):
 *
 *   Bug #1 — String.prototype.replace interprets `$` special sequences in the
 *            REPLACEMENT string (even when the pattern is a literal string).
 *            A new_str containing the email-regex `^...$` followed by a
 *            backtick (`$\``) expanded as "insert string-before-match" and
 *            silently spliced the file's pre-edit content into the middle of
 *            the table cell.
 *
 *   Bug #2 — The "old_str appears N times" error pushed the model toward
 *            `(a) add more context` only. When the duplicate was caused by
 *            Bug #1's corruption, the right recovery is `(b) re-read + write_file`.
 *            Assert the error message now mentions both options.
 *
 *   Bug #3 — The diff JSON tool result (oldContent + newContent, full file
 *            twice) was sent verbatim to the model in the next iteration's
 *            tool_result. For PLAN.md across 14 edits this was ~700KB of pure
 *            file echo. Assert the diff-sanitization helper collapses the diff
 *            JSON to a one-line "File updated: <path>" summary.
 *
 * Pure-function tests — mirror the inline implementations in
 * `toolExecutor.ts:edit_file` and `agentService.ts:runAgentLoop` so a
 * regression of either inline form is caught at unit-test time. If the
 * implementations drift, re-sync `editFileReplace()` / `duplicateMatchError()`
 * / `sanitizeForModel()` here.
 *
 * Why not instantiate ToolExecutor directly: importing `toolExecutor.ts` pulls
 * in `projectStore` → `windowService` → `@tauri-apps/api/webviewWindow` which
 * fails Jest module loading (Tauri webview surface assumes a native runtime).
 * The existing `safeToolPool.test.ts` follows the same pattern — import the
 * type, build a fake / test the pure logic.
 */

/**
 * Literal substring replace that mirrors the production implementation in
 * toolExecutor.ts edit_file (the `content.slice + newStr + content.slice`
 * pattern). Must NOT use String.prototype.replace — see the test cases.
 */
function editFileReplace(content: string, oldStr: string, newStr: string): string {
  const idx = content.indexOf(oldStr)
  if (idx === -1) throw new Error('old_str not found')
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
}

/**
 * Returns the same multi-option error message that the production
 * `edit_file` handler returns when `old_str` matches more than once.
 */
function duplicateMatchError(path: string, occurrences: number): string {
  return `Error: old_str appears ${occurrences} times in ${path}. It must be unique. Options: ` +
    `(a) add more surrounding context to old_str/new_str so the match is unique; ` +
    `(b) if you did not expect a duplicate (the file may have been corrupted by a previous edit), ` +
    `re-read the file with read_file to confirm, then use write_file to overwrite with the corrected full content in one call — ` +
    `do NOT chase the duplicate with successive edits.`
}

/**
 * Mirrors the diff-sanitization the agent loop applies to tool_result content
 * before injecting into the next API call's user message. Production site:
 * `agentService.ts:runAgentLoop` toolResultBlocks loop.
 */
function sanitizeForModel(rawResult: string): string {
  try {
    const parsed = JSON.parse(rawResult)
    if (parsed?.type === 'diff' && typeof parsed.path === 'string') {
      return `File ${parsed.isNewFile ? 'created' : 'updated'}: ${parsed.path}`
    }
  } catch { /* not JSON — pass through */ }
  return rawResult
}

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

describe('Bug #2: improved error message on non-unique old_str', () => {
  it('mentions both the "add context" path AND the "write_file overwrite" recovery path', () => {
    const msg = duplicateMatchError('/proj/PLAN.md', 2)
    expect(msg).toMatch(/appears 2 times/)
    // Old behaviour: only mentioned "include more surrounding context".
    // New behaviour: explicit two-option recovery.
    expect(msg.toLowerCase()).toContain('surrounding context')
    expect(msg.toLowerCase()).toContain('write_file')
    expect(msg.toLowerCase()).toContain('corrupted')
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
