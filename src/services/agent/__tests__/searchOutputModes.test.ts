/**
 * Modos compactos do search (auditoria 2026-07-28 — paridade com o Grep do
 * claude-vaz): files_with_matches/count devolvem ~1 linha por FICHEIRO, o que
 * torna honesto varrer até ao teto global (500) sem inundar o contexto.
 */
import { formatSearchResultsByFile } from '../toolExecutor/searchFormatters'
import { normalizeToolInputForCanonical } from '../toolNames'

const result = {
  files: [
    { file_path: '/proj/a.ts', total_matches: 3, matches: [{}, {}, {}] },
    { file_path: '/proj/b.ts', total_matches: 1, matches: [{}] },
  ],
  total_matches: 4,
  truncated: false,
}

describe('formatSearchResultsByFile', () => {
  it('files_with_matches: só caminhos, um por linha', () => {
    const out = formatSearchResultsByFile(result, 'files_with_matches')
    expect(out).toBe('2 files with matches:\n/proj/a.ts\n/proj/b.ts')
  })

  it('count: caminho + contagem por ficheiro, com total no cabeçalho', () => {
    const out = formatSearchResultsByFile(result, 'count')
    expect(out).toContain('4 matches across 2 files:')
    expect(out).toContain('/proj/a.ts: 3')
    expect(out).toContain('/proj/b.ts: 1')
  })

  it('truncagem é declarada, nunca silenciosa', () => {
    const out = formatSearchResultsByFile({ ...result, truncated: true }, 'files_with_matches')
    expect(out).toContain('[truncated at the global match cap')
  })

  it('sem matches diz exatamente isso', () => {
    expect(formatSearchResultsByFile({ files: [] }, 'count')).toBe('No matches found.')
  })
})

describe('Grep alias — dialecto claude-vaz (output_mode/head_limit)', () => {
  it('traduz output_mode e head_limit para os campos internos', () => {
    const out = normalizeToolInputForCanonical('Grep', {
      pattern: 'foo', path: '/proj', output_mode: 'files_with_matches', head_limit: 100,
    })
    expect(out.outputMode).toBe('files_with_matches')
    expect(out.maxResults).toBe(100)
    expect(out.query).toBe('foo')
    expect(out.directory).toBe('/proj')
  })

  it('os campos internos, quando presentes, têm precedência', () => {
    const out = normalizeToolInputForCanonical('Grep', {
      pattern: 'foo', outputMode: 'count', output_mode: 'content',
    })
    expect(out.outputMode).toBe('count')
  })
})
