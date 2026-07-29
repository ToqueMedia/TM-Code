import { READ_FILE, WRITE_FILE } from './toolNames'

/**
 * Shared helpers for `edit_file` and the agent loop's tool-result handling.
 * Extracted from inline implementations after the May 2026 PLAN.md loop
 * postmortem — production code AND tests import from here so a future
 * refactor of either side can't drift the contract.
 *
 * Three exports, one per bug fixed in that postmortem:
 *
 *   - `editFileReplace`  → literal substring replace (Bug #1: the
 *      `String.prototype.replace` $-sequence corruption).
 *   - `duplicateMatchError` → multi-option recovery message (Bug #2: the
 *      "add more context" hint that sent the model into a loop).
 *   - `editFileReplaceAll` → variante replace_all (rename de símbolo em 1 call).
 *   - (removido 2026-07-28) `sanitizeDiffForModel` (Bug #3, file-echo bloat) —
 *     ficou sem callers: o resultado NO-TURNO inclui agora o excerto
 *     pós-edição (changedFileSnippet.buildPostEditResultText) e o rebuild de
 *     histórico usa a sua cópia inline de uma linha (chatStore) — correto lá:
 *     turnos históricos não precisam de excerto.
 *
 * Pure functions, no Tauri / no React / no store imports — safe to unit
 * test in isolation without webview / project-store mocks.
 */

/**
 * Replace exactly one occurrence of `oldStr` in `content` with `newStr`,
 * literally — no `$&` / `` $` `` / `$'` / `$$` / `$n` interpretation.
 * (The argument names here are the function's internal names; the public
 * tool schema exposes these as `old_string` / `new_string`.)
 *
 * Why not `String.prototype.replace(oldStr, newStr)`: when `newStr` contains
 * a `$` followed by certain characters, JS expands it (even when `oldStr`
 * is a string, not a regex). The May 2026 PLAN.md session triggered this
 * with an email regex `^...\.[^\s@]+$` followed by a backtick — the `` $` ``
 * pattern injected the file's pre-match content into the middle of the
 * regex literal, corrupting the validation table and leaving two
 * `> Status: DRAFT` lines that broke the next edit's uniqueness check.
 *
 * Caller MUST verify uniqueness of `oldStr` before calling this — the
 * `indexOf === -1` invariant assert below is defensive only.
 */
export function editFileReplace(content: string, oldStr: string, newStr: string): string {
  const matchIdx = content.indexOf(oldStr)
  if (matchIdx === -1) {
    // Defensive: every production call site checks `occurrences > 0`
    // (via `content.split(oldStr).length - 1`) before reaching here, so
    // this should never trigger. Throwing keeps the failure loud if the
    // contract ever drifts.
    throw new Error('editFileReplace: oldStr not found in content (uniqueness check upstream is broken)')
  }
  return content.slice(0, matchIdx) + newStr + content.slice(matchIdx + oldStr.length)
}

/**
 * Error message returned by `edit_file` when `old_string` matches more than
 * once. The original message only listed option (a) — "add more context".
 * That instruction is correct for genuine ambiguity but wrong when the
 * duplicate is the AFTERMATH of a prior corruption (e.g. Bug #1 silently
 * spliced the file's prefix into the middle of an earlier edit, creating
 * new duplicates of formerly-unique anchors). The model would then spend
 * many turns searching for disambiguating context that doesn't exist.
 *
 * The new message lists BOTH paths explicitly and discourages chasing the
 * duplicate with successive edits — `read_file` + `write_file` overwrite
 * is one call, vs. N edits all hitting the same wall.
 */
export function duplicateMatchError(path: string, occurrences: number): string {
  // Tool names are interpolated from constants (#20 from prompt techniques
  // manual) so a future rename of read_file/write_file propagates here
  // without text drift.
  return `Error: old_string appears ${occurrences} times in ${path}. It must be unique. Options: ` +
    `(a) if ALL ${occurrences} occurrences should change (renaming a symbol/variable), retry with replace_all: true; ` +
    `(b) add more surrounding context to old_string/new_string so the match is unique; ` +
    `(c) if you did not expect a duplicate (the file may have been corrupted by a previous edit), ` +
    `re-read the file with ${READ_FILE} to confirm, then use ${WRITE_FILE} to overwrite with the corrected full content in one call — ` +
    `do NOT chase the duplicate with successive edits.`
}


/**
 * Replace EVERY occurrence of `oldStr`, literally — `split().join()` nunca
 * interpreta `$&`/`` $` ``/`$'`/`$$`/`$n`, portanto herda a imunidade à
 * corrupção do Bug #1 sem regex nenhum.
 *
 * Existe para o `replace_all` do edit_file (auditoria 2026-07-28): renomear um
 * símbolo com N ocorrências obrigava a N edits com contexto único inventado, ou
 * a reescrever o ficheiro inteiro com write_file — token-caro e propenso ao
 * próprio Bug #1 que este módulo documenta.
 */
export function editFileReplaceAll(content: string, oldStr: string, newStr: string): string {
  if (!content.includes(oldStr)) {
    throw new Error('editFileReplaceAll: oldStr not found in content (occurrence check upstream is broken)')
  }
  return content.split(oldStr).join(newStr)
}
