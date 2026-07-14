import {
  checkReadRangeOverlap,
  clearReadRangeTracker,
  getAndResetOverlapStats,
  getReadRanges,
  recordReadRange,
} from '../toolExecutor/readRangeTracker'

describe('readRangeTracker', () => {
  beforeEach(() => {
    clearReadRangeTracker()
  })

  it('treats missing limit as read-to-EOF and covers later subranges', () => {
    recordReadRange('/repo/subAgentRunner.ts', 1, undefined, 1, 1000)

    expect(getReadRanges()).toEqual([
      { path: '/repo/subAgentRunner.ts', offset: 1, limit: undefined, readToEnd: true },
    ])

    const overlap = checkReadRangeOverlap('/repo/subAgentRunner.ts', 90, 130, 1, 1000)
    expect(overlap.kind).toBe('fully_covered')
    expect(overlap.stub).toContain('previous Read')
    expect(overlap.stub).toContain('do not re-read this range')
    expect(overlap.stub).toContain('execute_command/cat/head/tail/sed')
    expect(overlap.stub).toContain('force: true')
    expect(getAndResetOverlapStats()).toEqual({
      skippedOverlappingReads: 1,
      adjustedReadRanges: 0,
    })
  })

  it('adjusts partially covered ranges to the first unread lines', () => {
    recordReadRange('/repo/subAgentRunner.ts', 1, 95, 1, 1000)

    const overlap = checkReadRangeOverlap('/repo/subAgentRunner.ts', 30, 200, 1, 1000)
    expect(overlap).toEqual({
      kind: 'partially_covered',
      adjustedRange: { offset: 96, limit: 134 },
    })
    expect(getAndResetOverlapStats()).toEqual({
      skippedOverlappingReads: 0,
      adjustedReadRanges: 1,
    })
  })

  it('does not reuse ranges after an observed mtime change', () => {
    recordReadRange('/repo/subAgentRunner.ts', 1, undefined, 1, 1000)

    expect(checkReadRangeOverlap('/repo/subAgentRunner.ts', 30, 200, 1, 2000)).toEqual({
      kind: 'not_covered',
    })
    expect(getAndResetOverlapStats()).toEqual({
      skippedOverlappingReads: 0,
      adjustedReadRanges: 0,
    })
  })
})
