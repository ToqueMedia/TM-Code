/**
 * Modos compactos do search (outputMode files_with_matches | count) —
 * auditoria 2026-07-28, paridade com o Grep do claude-vaz.
 *
 * Uma linha por FICHEIRO é o que torna honesto varrer até ao teto global do
 * Rust (500 matches) sem inundar o contexto; o modo content não conseguiria.
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
  const header = mode === 'count'
    ? `${total} match${total === 1 ? '' : 'es'} across ${files.length} file${files.length === 1 ? '' : 's'}:`
    : `${files.length} file${files.length === 1 ? '' : 's'} with matches:`
  const footer = truncated
    ? `\n[truncated at the global match cap — narrow the query or includePatterns to see the rest]`
    : ''
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
