import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
  validateLspInput,
  LSP_OPERATIONS,
} from '../lspTool'

describe('lspTool', () => {
  describe('validateLspInput', () => {
    it('accepts every operation with a valid shape', () => {
      for (const operation of LSP_OPERATIONS) {
        expect(
          validateLspInput({ operation, file_path: '/p/a.ts', line: 3, character: 7 }),
        ).toBeNull()
      }
    })

    it('rejects unknown/missing operations and missing file_path', () => {
      expect(validateLspInput({ operation: 'rename' as never, file_path: '/p/a.ts' })).toContain('operation')
      expect(validateLspInput({ file_path: '/p/a.ts' })).toContain('operation')
      expect(validateLspInput({ operation: 'hover' })).toContain('file_path')
    })

    it('requires 1-based integer line/character for positional operations only', () => {
      expect(validateLspInput({ operation: 'hover', file_path: '/p/a.ts' })).toContain('1-based')
      expect(
        validateLspInput({ operation: 'goToDefinition', file_path: '/p/a.ts', line: 0, character: 1 }),
      ).toContain('1-based')
      expect(
        validateLspInput({ operation: 'findReferences', file_path: '/p/a.ts', line: 2.5 as never, character: 1 }),
      ).toContain('1-based')
      // Non-positional ops don't need a position.
      expect(validateLspInput({ operation: 'diagnostics', file_path: '/p/a.ts' })).toBeNull()
      expect(validateLspInput({ operation: 'documentSymbol', file_path: '/p/a.ts' })).toBeNull()
    })
  })

  describe('formatters', () => {
    const loc = (over: Partial<{ path: string; line: number; column: number; preview: string }> = {}) => ({
      path: '/p/src/a.ts',
      line: 10,
      column: 5,
      preview: 'export function alpha() {',
      ...over,
    })

    it('formats definitions as path:line:col with previews', () => {
      const out = formatLocations('goToDefinition', [loc()])
      expect(out).toContain('1 definition(s):')
      expect(out).toContain('/p/src/a.ts:10:5 — export function alpha() {')
    })

    it('empty references point the model at grep for exhaustive search', () => {
      expect(formatLocations('findReferences', [])).toContain('grep')
      expect(formatLocations('goToDefinition', [])).toContain('No definition')
    })

    it('reference results carry the loaded-files scope caveat', () => {
      expect(formatLocations('findReferences', [loc(), loc({ line: 22 })])).toContain('loaded so far')
    })

    it('formats hover and its empty case', () => {
      expect(formatHover('/p/a.ts', 3, 7, 'const x: number')).toBe('const x: number')
      expect(formatHover('/p/a.ts', 3, 7, null)).toContain('No type information at /p/a.ts:3:7')
    })

    it('formats document symbols with depth indentation', () => {
      const out = formatSymbols('/p/a.ts', [
        { name: 'Alpha', kind: 'class', line: 1, depth: 0 },
        { name: 'method', kind: 'method', line: 4, depth: 1 },
      ])
      expect(out).toContain('2 symbol(s) in /p/a.ts:')
      expect(out).toContain('class Alpha — :1')
      expect(out).toContain('  method method — :4')
    })

    it('formats diagnostics with severity counts and caps the listing at 50', () => {
      const many = Array.from({ length: 55 }, (_, i) => ({
        line: i + 1,
        column: 1,
        message: `boom ${i}`,
        severity: 'error' as const,
        code: 2304,
      }))
      const out = formatDiagnostics('/p/a.ts', many)
      expect(out).toContain('55 error(s), 0 warning(s)')
      expect(out).toContain(':1:1 error TS2304 — boom 0')
      expect(out).toContain('(+5 more)')
      expect(formatDiagnostics('/p/a.ts', [])).toContain('No TypeScript/JavaScript errors')
    })
  })
})
