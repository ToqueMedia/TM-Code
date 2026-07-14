import { parseMergeConflicts, resolvedTextFor } from '../mergeConflicts'

const SIMPLE = [
  'const a = 1',
  '<<<<<<< HEAD',
  'const b = 2',
  '=======',
  'const b = 3',
  '>>>>>>> feature',
  'const c = 4',
]

const DIFF3 = [
  '<<<<<<< HEAD',
  'ours',
  '||||||| base',
  'original',
  '=======',
  'theirs',
  '>>>>>>> branch',
]

describe('parseMergeConflicts', () => {
  it('parses a simple conflict with labels and 1-based lines', () => {
    const conflicts = parseMergeConflicts(SIMPLE)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      headerLine: 2,
      splitterLine: 4,
      footerLine: 6,
      currentLabel: 'HEAD',
      incomingLabel: 'feature',
    })
    expect(conflicts[0].ancestorsLine).toBeUndefined()
  })

  it('parses diff3 conflicts with the common-ancestors block', () => {
    const [conflict] = parseMergeConflicts(DIFF3)
    expect(conflict.ancestorsLine).toBe(3)
    expect(conflict.splitterLine).toBe(5)
  })

  it('parses multiple conflicts and ignores malformed leftovers', () => {
    const lines = [...SIMPLE, '<<<<<<< HEAD', 'orphan without footer', ...SIMPLE]
    const conflicts = parseMergeConflicts(lines)
    expect(conflicts).toHaveLength(2)
    // 7 linhas do 1º SIMPLE + 2 linhas órfãs + header na 2ª linha do 2º SIMPLE.
    expect(conflicts[1].headerLine).toBe(SIMPLE.length + 2 + 2)
  })

  it('does not treat ======= outside a conflict as a splitter', () => {
    expect(parseMergeConflicts(['=======', 'texto', '>>>>>>> x'])).toHaveLength(0)
  })
})

describe('resolvedTextFor', () => {
  const [conflict] = parseMergeConflicts(SIMPLE)

  it('accept current keeps only the local side', () => {
    expect(resolvedTextFor(SIMPLE, conflict, 'current')).toBe('const b = 2')
  })

  it('accept incoming keeps only the incoming side', () => {
    expect(resolvedTextFor(SIMPLE, conflict, 'incoming')).toBe('const b = 3')
  })

  it('accept both keeps current followed by incoming', () => {
    expect(resolvedTextFor(SIMPLE, conflict, 'both')).toBe('const b = 2\nconst b = 3')
  })

  it('drops the ancestors block in diff3 conflicts', () => {
    const [diff3] = parseMergeConflicts(DIFF3)
    expect(resolvedTextFor(DIFF3, diff3, 'both')).toBe('ours\ntheirs')
  })
})
