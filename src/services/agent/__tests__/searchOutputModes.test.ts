/**
 * Modos compactos do search (auditoria 2026-07-28 — paridade com o Grep do
 * claude-vaz): files_with_matches/count devolvem ~1 linha por FICHEIRO.
 */
import { formatSearchResultsByFile, resolveGrepHeadLimit } from '../toolExecutor/searchFormatters'
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
    // "(true totals)" desde 2026-07-29: o count corre em CountOnly, sem
    // tecto por ficheiro. O sufixo distingue este regime do content.
    expect(out).toContain('4 matches across 2 files (true totals):')
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

  it('corte a meio do ficheiro fala do head_limit global, não de um tecto por ficheiro', () => {
    const out = formatSearchResultsByFile({
      files: [{ file_path: '/proj/a.ts', total_matches: 10, capped_at_file_limit: true }],
      truncated: true,
    }, 'count')
    expect(out).toContain('cut mid-file by the global head_limit')
    expect(out).not.toContain('per-file cap')
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

  it('head_limit: 0 passa como maxResults 0 (sem tecto), não como default', () => {
    const out = normalizeToolInputForCanonical('Grep', {
      pattern: 'foo', path: '/proj', head_limit: 0,
    })
    expect(out.maxResults).toBe(0)
  })
})

describe('resolveGrepHeadLimit — paridade cli-vaz', () => {
  it('default 250 quando o modelo não passa nada', () => {
    expect(resolveGrepHeadLimit(undefined)).toBe(250)
    expect(resolveGrepHeadLimit(null)).toBe(250)
    expect(resolveGrepHeadLimit('')).toBe(250)
    expect(resolveGrepHeadLimit(-1)).toBe(250)
    expect(resolveGrepHeadLimit(Number.NaN)).toBe(250)
  })

  it('0 (número ou string) é ilimitado', () => {
    expect(resolveGrepHeadLimit(0)).toBe(0)
    expect(resolveGrepHeadLimit('0')).toBe(0)
  })

  it('valores positivos passam (sem tecto de 200)', () => {
    expect(resolveGrepHeadLimit(100)).toBe(100)
    expect(resolveGrepHeadLimit(400)).toBe(400)
    expect(resolveGrepHeadLimit('30')).toBe(30)
  })
})
