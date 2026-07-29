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

/** Teto do excerto pós-edição. O snippet acima vai até 8K, mas isso é para um
 *  ficheiro inteiro mudado por fora; aqui há um por CADA edição aplicada. */
const POST_EDIT_SNIPPET_MAX_CHARS = 2_000

/**
 * Texto do resultado de uma edição, como o MODELO o vê.
 *
 * PORQUÊ (auditoria 2026-07-28): o resultado era só "File updated: path" — o
 * modelo aplicava a edição e ficava sem ver nada do que ficou escrito. Daí saem
 * os dois comportamentos caros: ou re-lê o ficheiro que acabou de editar (um
 * turn inteiro), ou encadeia a edição seguinte às cegas sobre um estado que
 * assume. Devolver o excerto numerado da zona alterada é o que o claude-vaz
 * faz — e o snippet já existia aqui, usado só no sweep de alterações externas.
 *
 * Partilhado pelo caminho direto (query.ts) e pelo de APROVAÇÃO
 * (agentService.ts): eram dois formatos a divergir para o mesmo evento.
 */
export function buildPostEditResultText(diff: {
  path?: unknown
  isNewFile?: unknown
  oldContent?: unknown
  newContent?: unknown
}): string {
  const path = typeof diff.path === 'string' ? diff.path : '(unknown path)'
  const isNewFile = diff.isNewFile === true
  const header = `File ${isNewFile ? 'created' : 'updated'}: ${path}`

  const oldContent = typeof diff.oldContent === 'string' ? diff.oldContent : ''
  const newContent = typeof diff.newContent === 'string' ? diff.newContent : ''

  let snippet = ''
  try {
    snippet = isNewFile
      ? addLineNumbers({ content: newContent.split('\n').slice(0, 20).join('\n'), startLine: 1 })
      : getSnippetForTwoFileDiff(oldContent, newContent)
  } catch {
    // Um excerto é um extra: nunca pode partir o resultado da edição.
  }
  if (!snippet) return header

  if (snippet.length > POST_EDIT_SNIPPET_MAX_CHARS) {
    const cut = snippet.lastIndexOf('\n', POST_EDIT_SNIPPET_MAX_CHARS)
    snippet = `${snippet.slice(0, cut > 0 ? cut : POST_EDIT_SNIPPET_MAX_CHARS)}\n… (excerpt truncated — read the file if you need more)`
  }
  return `${header}\n\nResulting content (verify it says what you intended — do NOT re-read this file just to check):\n${snippet}`
}
