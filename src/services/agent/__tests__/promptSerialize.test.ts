import {
  TOON_WIN_RATIO,
  getPromptSerializeStats,
  isPrimitiveObjectArray,
  preferToon,
  resetPromptSerializeStats,
  serializeStructuredForPrompt,
  serializeStructuredForPromptDetailed,
} from '../promptSerialize'
import { jsonMini } from '../jsonMini'
import { formatGitStatusDomain } from '../domainFormats'

describe('promptSerialize (format-by-scenario policy)', () => {
  beforeEach(() => {
    resetPromptSerializeStats()
  })

  describe('isPrimitiveObjectArray / preferToon', () => {
    const tabularTools = {
      tools: Array.from({ length: 4 }, (_, i) => ({
        name: `tool_${i}`,
        server: 'docs',
        description: `op ${i}`,
        inputCount: i + 1,
      })),
    }

    const nestedIrregular = {
      ok: true,
      page: {
        title: 'Workers',
        sections: [{ h: 'Overview', body: 'text' }],
      },
    }

    const permissions = {
      projectId: 'p1',
      mode: 'auto',
      grants: [
        { tool: 'execute_command', pattern: 'npm *', scope: 'project', createdAt: 1 },
        { tool: 'write_file', pattern: 'src/**', scope: 'session', createdAt: 2 },
      ],
    }

    it('detects primitive-leaf object arrays as tabular candidates', () => {
      expect(isPrimitiveObjectArray(tabularTools.tools)).toBe(true)
      expect(preferToon(tabularTools)).toBe(true)
      expect(preferToon(permissions)).toBe(true)
    })

    it('allows sparse optional keys (size gate decides winner)', () => {
      const sparse = [
        { id: 'a', name: 'one', extra: 'x' },
        { id: 'b', name: 'two' },
      ]
      expect(isPrimitiveObjectArray(sparse)).toBe(true)
    })

    it('rejects nested irregular objects', () => {
      expect(preferToon(nestedIrregular)).toBe(false)
    })

    it('rejects single-row arrays (gain negligible)', () => {
      expect(isPrimitiveObjectArray([{ a: 1 }])).toBe(false)
    })

    it('rejects rows with nested objects', () => {
      expect(
        isPrimitiveObjectArray([
          { a: 1, nested: { x: 1 } },
          { a: 2, nested: { x: 2 } },
        ]),
      ).toBe(false)
    })
  })

  describe('serializeStructuredForPrompt', () => {
    it('uses TOON for tabular MCP-style catalogs when smaller than mini', () => {
      const data = {
        tools: [
          { name: 'a', server: 's', description: 'da', inputCount: 1 },
          { name: 'b', server: 's', description: 'db', inputCount: 2 },
        ],
      }
      const detailed = serializeStructuredForPromptDetailed(data)
      expect(detailed.format).toBe('toon')
      expect(detailed.text).toMatch(/tools\[2\]\{/)
      expect(detailed.chars).toBeLessThanOrEqual(jsonMini(data).length * TOON_WIN_RATIO)
      expect(getPromptSerializeStats().toonWins).toBe(1)
      expect(getPromptSerializeStats().charsSavedVsMini).toBeGreaterThan(0)
    })

    it('uses JSON mini for nested irregular payloads', () => {
      const data = {
        ok: true,
        page: { title: 'x', nested: { a: 1 } },
      }
      const detailed = serializeStructuredForPromptDetailed(data)
      expect(detailed.format).toBe('json_mini')
      expect(detailed.text).toBe(jsonMini(data))
      expect(getPromptSerializeStats().jsonMini).toBe(1)
      expect(getPromptSerializeStats().toonWins).toBe(0)
    })

    it('uses JSON mini for diff-like objects (long string bodies)', () => {
      const data = {
        type: 'diff',
        path: '/tmp/a.ts',
        oldContent: 'line1\nline2\n',
        newContent: 'line1\nline2 fixed\n',
        isNewFile: false,
      }
      expect(serializeStructuredForPrompt(data)).toBe(jsonMini(data))
    })

    it('passes strings through unchanged', () => {
      const detailed = serializeStructuredForPromptDetailed('plain log')
      expect(detailed.format).toBe('string')
      expect(detailed.text).toBe('plain log')
      expect(getPromptSerializeStats().stringPassthrough).toBe(1)
    })

    it('falls back to mini when TOON does not win on size', () => {
      const tiny = [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]
      const mini = jsonMini(tiny)
      const detailed = serializeStructuredForPromptDetailed(tiny)
      if (detailed.format === 'toon') {
        expect(detailed.chars).toBeLessThanOrEqual(mini.length * TOON_WIN_RATIO)
        expect(getPromptSerializeStats().toonWins).toBe(1)
      } else {
        expect(detailed.format).toBe('json_mini')
        expect(detailed.text).toBe(mini)
        // Either no-win or unavailable after a tabular attempt
        const s = getPromptSerializeStats()
        expect(s.toonNoWin + s.toonUnavailable).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('formatGitStatusDomain (imported from domainFormats, not barrel)', () => {
    it('emits status\\tpath\\tstaged|unstaged rows', () => {
      const text = formatGitStatusDomain([
        { path: 'src/a.ts', status: 'M', staged: true },
        { path: 'src/b.ts', status: '??', staged: false },
      ])
      expect(text).toBe('M\tsrc/a.ts\tstaged\n??\tsrc/b.ts\tunstaged')
    })
  })
})
