import { buildRequestEfficiencyReport, sessionToJson, sessionToMarkdown } from '../sessionExport'
import type { ChatSession, RequestUsageEntry } from '@/types/chat'

function usage(overrides: Partial<RequestUsageEntry>): RequestUsageEntry {
  return {
    requestId: overrides.requestId ?? `req-${overrides.turn ?? 1}`,
    turn: overrides.turn ?? 1,
    model: overrides.model ?? 'test-model',
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    estimatedInputTokens: overrides.estimatedInputTokens ?? 0,
    breakdown: overrides.breakdown ?? {},
    ...overrides,
  }
}

function session(requestUsageLog: RequestUsageEntry[]): ChatSession {
  return {
    id: 'session-1',
    projectPath: '/repo',
    messages: [],
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    requestUsageLog,
  }
}

describe('sessionExport request efficiency report', () => {
  it('summarizes symbol-index usage and uses the final read range snapshot', () => {
    const log = [
      usage({
        requestId: 'r1',
        turn: 1,
        readRanges: [
          { path: '/repo/src/a.ts', offset: 1, readToEnd: true },
        ],
      }),
      usage({
        requestId: 'r2',
        turn: 2,
        symbolIndexRequested: true,
        symbolIndexFilesConsidered: 30,
        symbolIndexFilesScanned: 10,
        symbolIndexEntries: 50,
        symbolIndexTokensEstimate: 700,
        readRanges: [
          { path: '/repo/src/a.ts', offset: 1, readToEnd: true },
        ],
        skippedOverlappingReads: 1,
      }),
      usage({
        requestId: 'r3',
        turn: 3,
        readRanges: [
          { path: '/repo/src/a.ts', offset: 1, readToEnd: true },
          { path: '/repo/src/b.ts', offset: 40, limit: 20, readToEnd: false },
        ],
        adjustedReadRanges: 2,
        readBeforeWriteBlockCount: 1,
        readBeforeWriteBlockedTools: ['edit_file'],
        readBeforeWriteBlockedReasons: ['not_read'],
      }),
    ]

    expect(buildRequestEfficiencyReport(log)).toEqual({
      totalRequests: 3,
      symbolIndexRequests: 1,
      symbolIndexTokensEstimate: 700,
      symbolIndexFilesConsidered: 30,
      symbolIndexFilesScanned: 10,
      symbolIndexEntries: 50,
      symbolIndexTruncated: false,
      finalReadRangeCount: 2,
      finalReadRangeFileCount: 2,
      finalReadToEndRangeCount: 1,
      finalBoundedReadRangeCount: 1,
      skippedOverlappingReads: 1,
      adjustedReadRanges: 2,
      readBeforeWriteBlockCount: 1,
      readBeforeWriteBlockedTools: ['edit_file'],
      readBeforeWriteBlockedReasons: ['not_read'],
      firstSymbolIndexRequest: { requestNumber: 2, turn: 2 },
      readRangesBeforeFirstSymbolIndex: 1,
      readRangesAfterFirstSymbolIndex: 1,
    })
  })

  it('includes the efficiency report in JSON and Markdown exports', () => {
    const log = [
      usage({
        requestId: 'r1',
        turn: 1,
        symbolIndexRequested: true,
        symbolIndexFilesConsidered: 3,
        symbolIndexFilesScanned: 2,
        symbolIndexEntries: 8,
        symbolIndexTokensEstimate: 120,
        readRanges: [{ path: '/repo/src/a.ts', offset: 1, limit: 30, readToEnd: false }],
      }),
    ]

    const json = JSON.parse(sessionToJson(session(log)))
    expect(json.session.requestEfficiencyReport).toMatchObject({
      symbolIndexRequests: 1,
      symbolIndexTokensEstimate: 120,
      finalReadRangeCount: 1,
    })

    const markdown = sessionToMarkdown(session(log))
    expect(markdown).toContain('**Agent reading efficiency:**')
    expect(markdown).toContain('| symbol index requests | 1 / 1 |')
    expect(markdown).toContain('| bounded ranges | 1 |')
  })
})
