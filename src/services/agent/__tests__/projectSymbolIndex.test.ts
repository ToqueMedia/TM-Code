import { invoke } from '@/utils/invokeMetrics'
import {
  buildProjectSymbolIndexSection,
  extractProjectSymbolsFromContent,
  formatProjectSymbolIndex,
  type ProjectSymbolIndex,
} from '../contextBuilder/projectSymbolIndex'
import { __resetIpcCacheForTests } from '../ipcCache'
import { getTmsTurnTelemetry, setTmsTurnTelemetry } from '../tmsContext'

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn(),
}))

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

describe('projectSymbolIndex', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    __resetIpcCacheForTests()
    setTmsTurnTelemetry({
      symbolIndexRequested: false,
      symbolIndexFilesConsidered: 0,
      symbolIndexFilesScanned: 0,
      symbolIndexEntries: 0,
      symbolIndexTruncated: false,
      symbolIndexTokensEstimate: 0,
    })
  })

  it('extracts lightweight symbols with line numbers and nearby comments', () => {
    const content = [
      'import React from "react"',
      '',
      '/** Builds the primary session list. */',
      'export function SessionList() {',
      '  return null',
      '}',
      '',
      '// Coordinates agent request dispatch.',
      'const requestHandler = () => {}',
      '',
      'export interface SessionRecord {',
      '  id: string',
      '}',
    ].join('\n')

    expect(extractProjectSymbolsFromContent('src/components/SessionList.tsx', content)).toEqual([
      {
        path: 'src/components/SessionList.tsx',
        line: 4,
        kind: 'component/function',
        name: 'SessionList',
        summary: 'Builds the primary session list.',
      },
      {
        path: 'src/components/SessionList.tsx',
        line: 9,
        kind: 'hook/provider/handler',
        name: 'requestHandler',
        summary: 'Coordinates agent request dispatch.',
      },
      {
        path: 'src/components/SessionList.tsx',
        line: 11,
        kind: 'type',
        name: 'SessionRecord',
        summary: 'export interface SessionRecord {',
      },
    ])
  })

  it('formats the index as navigation guidance, not editable source', () => {
    const index: ProjectSymbolIndex = {
      filesConsidered: 2,
      filesScanned: 1,
      truncated: false,
      entries: [
        {
          path: 'src/services/agent/contextBuilder.ts',
          line: 368,
          kind: 'method',
          name: 'loadAuxiliaryOnDemand',
          summary: 'Load an omitted auxiliary context on demand.',
        },
      ],
    }

    const formatted = formatProjectSymbolIndex(index)

    expect(formatted).toContain('# Project symbol index')
    expect(formatted).toContain('not source code and not edit permission')
    expect(formatted).toContain('call Read on the exact file/range')
    expect(formatted).toContain('## src/services/agent/contextBuilder.ts')
    expect(formatted).toContain('L368 loadAuxiliaryOnDemand')
  })

  it('records telemetry when the on-demand section is built', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'glob_files') {
        const pattern = (args as Record<string, unknown>)?.pattern
        return pattern === '**/*.ts' ? ['/repo/src/service.ts'] : []
      }
      if (cmd === 'file_stat') {
        return { size: 120 }
      }
      if (cmd === 'read_file') {
        return [
          '// Handles checkout submission.',
          'export function handleCheckout() {',
          '  return null',
          '}',
        ].join('\n')
      }
      return null
    })

    const section = await buildProjectSymbolIndexSection('/repo')

    expect(section).toContain('L2 handleCheckout')
    expect(getTmsTurnTelemetry()).toMatchObject({
      symbolIndexRequested: true,
      symbolIndexFilesConsidered: 1,
      symbolIndexFilesScanned: 1,
      symbolIndexEntries: 1,
      symbolIndexTruncated: false,
    })
    expect(getTmsTurnTelemetry().symbolIndexTokensEstimate).toBeGreaterThan(0)
  })
})
