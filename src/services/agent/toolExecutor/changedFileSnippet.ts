/**
 * Changed-file diff snippet — verbatim port of claude-vaz's
 * `getSnippetForTwoFileDiff` + `addLineNumbers` (FileEditTool/utils.ts:362-406,
 * utils/file.ts:290-319).
 *
 * Used by the external-modification sweep (`collectExternallyChangedFiles`):
 * when a file the model has read is later modified outside the agent's tools
 * (formatter, git pull, manual edit), the model receives a system-reminder
 * note with this snippet showing the post-edit content of the changed hunks
 * — deleted lines are filtered out, kept lines carry the claude-vaz `N→`
 * line-number prefix so the model can reference exact positions.
 */

import { structuredPatch } from 'diff'

/** Max snippet size shipped to the model — claude-vaz DIFF_SNIPPET_MAX_BYTES. */
const DIFF_SNIPPET_MAX_BYTES = 8192

/** Hunk context lines — claude-vaz passes {context: 8} to structuredPatch. */
const DIFF_CONTEXT_LINES = 8

/**
 * Prefix each line with its 1-indexed line number in claude-vaz's Read-tool
 * format: right-aligned to 6 chars + `→`. Numbers of 6+ digits skip padding.
 */
export function addLineNumbers({ content, startLine }: { content: string; startLine: number }): string {
  if (!content) {
    return ''
  }

  return content
    .split(/\r?\n/)
    .map((line, index) => {
      const numStr = String(index + startLine)
      if (numStr.length >= 6) {
        return `${numStr}→${line}`
      }
      return `${numStr.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

/** Count occurrences of `ch` in `str` starting at `fromIndex`. */
function countCharInString(str: string, ch: string, fromIndex = 0): number {
  let count = 0
  for (let i = fromIndex; i < str.length; i++) {
    if (str[i] === ch) count++
  }
  return count
}

/**
 * Produce the post-edit snippet for an externally-modified file: changed
 * hunks (8 context lines) with deletions and diff metadata stripped, line
 * numbers added, hunks joined by `...`, capped at 8 KB on a line boundary.
 *
 * Returns '' when the contents are byte-identical (file touched but not
 * modified) — callers must skip the notification in that case.
 */
export function getSnippetForTwoFileDiff(fileAContents: string, fileBContents: string): string {
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
    { context: DIFF_CONTEXT_LINES },
  )

  if (!patch) {
    return ''
  }

  const full = patch.hunks
    .map(hunk => ({
      startLine: hunk.oldStart,
      content: hunk.lines
        // Filter out deleted lines AND diff metadata lines ("\ No newline...")
        .filter(line => !line.startsWith('-') && !line.startsWith('\\'))
        .map(line => line.slice(1))
        .join('\n'),
    }))
    .map(addLineNumbers)
    .join('\n...\n')

  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

  // Truncate at the last line boundary that fits within the cap.
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept = cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}
