/**
 * Domain-specific prompt formats that beat both JSON mini and TOON in the
 * 2026-07-24 bench (when a dedicated formatter exists).
 *
 * Search / tree / glob / tasks / shell logs live next to their tools in
 * toolExecutor — not here — because they need tool-local context.
 */

/**
 * Git status rows — domain TSV won over JSON mini and TOON for homogeneous
 * file-status lists. Columns: `status`, `path`, `staged|unstaged`.
 */
export function formatGitStatusDomain(
  files: ReadonlyArray<{ path: string; status: string; staged?: boolean }>,
): string {
  return files
    .map((f) => `${f.status}\t${f.path}\t${f.staged ? 'staged' : 'unstaged'}`)
    .join('\n')
}
