import { compactionPercentForElapsed, formatCompactElapsed } from '../useCompactionProgress'

describe('compactionPercentForElapsed', () => {
  it('starts at a visible minimum (never 0) so the bar is immediately present', () => {
    expect(compactionPercentForElapsed(0)).toBe(1)
    expect(compactionPercentForElapsed(-500)).toBe(1) // clamps negative elapsed
  })

  it('is monotonically non-decreasing as time passes', () => {
    let prev = -1
    for (let ms = 0; ms <= 600_000; ms += 1_000) {
      const p = compactionPercentForElapsed(ms)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  it('never reaches 100% (compaction has no real completion signal)', () => {
    expect(compactionPercentForElapsed(10 * 60_000)).toBeLessThanOrEqual(95)
    expect(compactionPercentForElapsed(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(95)
  })

  it('climbs to a reassuring level within typical compaction durations', () => {
    // ~45s in we should be past a third of the way (asymptote, not linear).
    expect(compactionPercentForElapsed(45_000)).toBeGreaterThan(40)
    expect(compactionPercentForElapsed(45_000)).toBeLessThan(70)
  })
})

describe('formatCompactElapsed', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatCompactElapsed(0)).toBe('0s')
    expect(formatCompactElapsed(5_400)).toBe('5s')
    expect(formatCompactElapsed(59_999)).toBe('59s')
  })

  it('formats minute+ as "Xm Ys"', () => {
    expect(formatCompactElapsed(60_000)).toBe('1m 0s')
    expect(formatCompactElapsed(97_000)).toBe('1m 37s')
  })
})
