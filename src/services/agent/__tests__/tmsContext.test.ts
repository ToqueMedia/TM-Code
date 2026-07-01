import {
  decorateTmsRequestUsage,
  getTmsTurnTelemetry,
  markProjectSymbolIndexRequested,
  markReadBeforeWriteBlocked,
  markTmsCreated,
  setTmsTurnTelemetry,
} from '../tmsContext'
import type { RequestUsageEntry } from '@/types/chat'

function usageEntry(): RequestUsageEntry {
  return {
    requestId: 'req-1',
    turn: 1,
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 2,
    estimatedInputTokens: 10,
    breakdown: {},
  }
}

describe('tmsContext read-before-write telemetry', () => {
  beforeEach(() => {
    setTmsTurnTelemetry({
      readBeforeWriteBlocked: false,
      readBeforeWriteBlockCount: 0,
      readBeforeWriteBlockedTools: [],
      readBeforeWriteBlockedReasons: [],
      symbolIndexRequested: false,
      symbolIndexFilesConsidered: 0,
      symbolIndexFilesScanned: 0,
      symbolIndexEntries: 0,
      symbolIndexTruncated: false,
      symbolIndexTokensEstimate: 0,
    })
  })

  it('counts read-before-write blocks and decorates request usage', () => {
    markReadBeforeWriteBlocked('edit_file', 'not_read')
    markReadBeforeWriteBlocked('write_file', 'modified_since_read')
    markReadBeforeWriteBlocked('edit_file', 'not_read')

    const telemetry = getTmsTurnTelemetry()
    expect(telemetry).toMatchObject({
      readBeforeWriteBlocked: true,
      readBeforeWriteBlockCount: 3,
      readBeforeWriteBlockedTools: ['edit_file', 'write_file'],
      readBeforeWriteBlockedReasons: ['not_read', 'modified_since_read'],
    })

    const decorated = decorateTmsRequestUsage(usageEntry(), '')
    expect(decorated).toMatchObject({
      requestId: 'req-1',
      readBeforeWriteBlocked: true,
      readBeforeWriteBlockCount: 3,
      readBeforeWriteBlockedTools: ['edit_file', 'write_file'],
      readBeforeWriteBlockedReasons: ['not_read', 'modified_since_read'],
    })
  })

  it('decorates request usage with project symbol index metrics', () => {
    markProjectSymbolIndexRequested({
      filesConsidered: 42,
      filesScanned: 12,
      entries: 80,
      truncated: true,
      tokensEstimate: 900,
    })

    const decorated = decorateTmsRequestUsage(usageEntry(), '')
    expect(decorated).toMatchObject({
      symbolIndexRequested: true,
      symbolIndexFilesConsidered: 42,
      symbolIndexFilesScanned: 12,
      symbolIndexEntries: 80,
      symbolIndexTruncated: true,
      symbolIndexTokensEstimate: 900,
    })
  })

  it('marks a bootstrap write as updated when TMS.md existed at preflight', () => {
    setTmsTurnTelemetry({
      tmsFound: true,
      tmsFoundAtStart: true,
      tmsBootstrapTriggered: true,
      tmsCreated: false,
      tmsAlreadyExists: false,
      tmsBootstrapPhase: 'preflight_invalid',
    })

    markTmsCreated('/repo/TMS.md')

    expect(getTmsTurnTelemetry()).toMatchObject({
      tmsCreated: false,
      tmsAlreadyExists: true,
      tmsBootstrapCompleted: true,
      tmsBootstrapPhase: 'updated',
      tmsPath: '/repo/TMS.md',
    })
  })
})
