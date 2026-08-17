/** Paridade cli-vaz `DEFAULT_HEAD_LIMIT`. `0` = sem tecto. */
export const GREP_DEFAULT_HEAD_LIMIT = 250

/** Resolve maxResults/head_limit: default 250, 0 = unlimited. */
export function resolveGrepHeadLimit(raw: unknown): number {
  if (raw === 0 || raw === '0') return 0
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return GREP_DEFAULT_HEAD_LIMIT
}

/**
 * Modos compactos do search (outputMode files_with_matches | count) —
 * auditoria 2026-07-28, paridade com o Grep do claude-vaz.
 *
 * Uma linha por FICHEIRO é o que torna honesto varrer até ao head_limit
 * global (default 250; 0 = sem tecto) sem inundar o contexto.
 *
 * Módulo puro (sem Tauri/React/stores) — o padrão editLiteralReplace: produção
 * e testes importam daqui, e o teste não precisa da mock-suite do executor.
 */
export function formatSearchResultsByFile(result: unknown, mode: 'files_with_matches' | 'count'): string {
  const obj = (result && typeof result === 'object') ? result as Record<string, unknown> : {}
  const files = Array.isArray(obj.files) ? obj.files as Array<Record<string, unknown>> : []
  if (files.length === 0) return 'No matches found.'
  const truncated = obj.truncated === true
  const lines: string[] = []
  let total = 0
  for (const f of files) {
    const filePath = (f.file_path ?? f.path ?? '?') as string
    const count = typeof f.total_matches === 'number'
      ? f.total_matches
      : Array.isArray(f.matches) ? (f.matches as unknown[]).length : 0
    total += count
    lines.push(mode === 'count' ? `${filePath}: ${count}` : filePath)
  }
  // `count` recebe os totais REAIS do Rust (SearchDepth::CountOnly).
  // `capped_at_file_limit` agora significa: o head_limit GLOBAL esgotou a
  // meio deste ficheiro — já não há tecto de 10 por ficheiro.
  const capped = files.filter((f) => f.capped_at_file_limit === true).length
  const header = mode === 'count'
    ? `${total} match${total === 1 ? '' : 'es'} across ${files.length} file${files.length === 1 ? '' : 's'} (true totals):`
    : `${files.length} file${files.length === 1 ? '' : 's'} with matches:`
  const footer = [
    truncated
      ? `\n[truncated at the global match cap — raise maxResults/head_limit (0 = unlimited) or narrow the query]`
      : '',
    capped > 0
      ? `\n[${capped} file${capped === 1 ? '' : 's'} were cut mid-file by the global head_limit — the counts above are what was returned, not what exists]`
      : '',
    typeof obj.skipped_too_large === 'number' && obj.skipped_too_large > 0
      ? `\n[${obj.skipped_too_large} file(s) over 1 MB were NOT searched (size cap) — read them directly if the answer could live in a bundle or generated file]`
      : '',
  ].join('')
  return `${header}\n${lines.join('\n')}${footer}`
}

/**
 * Glob simples (`*`, `?`) contra o NOME de uma entrada — o dialecto que o
 * `ignore` do LS de treino usa (`*.test.ts`, `node_modules`).
 *
 * Deliberadamente sem `**`: aqui compara-se um nome, não um caminho, portanto
 * travessia de diretórios não se aplica. Os metacaracteres de regex são
 * escapados antes de `*`/`?` virarem quantificadores — sem isso um `ignore`
 * com `.` ou `+` construía uma regex que casava de mais.
 */
export function matchesAnyGlob(name: string, globs: string[]): boolean {
  return globs.some((glob) => {
    if (!glob) return false
    const rx = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp(`^${rx}$`).test(name)
    } catch {
      return false
    }
  })
}
