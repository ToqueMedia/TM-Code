import {
  MEMORY_OLD_DAYS,
  MEMORY_STALE_DAYS,
  isMemoryStale,
  memoryAgeDays,
  memoryAgeWarning,
} from '../memoryAge'

const NOW = Date.parse('2026-05-20T12:00:00Z')
const day = (n: number) => NOW - n * 24 * 60 * 60 * 1000

describe('memoryAgeDays', () => {
  it('returns 0 for today', () => {
    expect(memoryAgeDays(NOW, NOW)).toBe(0)
  })

  it('returns whole-day age', () => {
    expect(memoryAgeDays(day(7), NOW)).toBe(7)
    expect(memoryAgeDays(day(45), NOW)).toBe(45)
  })

  it('returns 0 for missing mtime (sentinel)', () => {
    expect(memoryAgeDays(0, NOW)).toBe(0)
  })

  it('returns 0 for future mtimes (clock skew tolerance)', () => {
    expect(memoryAgeDays(NOW + 5_000, NOW)).toBe(0)
  })
})

describe('isMemoryStale', () => {
  it('false below the stale threshold', () => {
    expect(isMemoryStale(day(MEMORY_STALE_DAYS - 1), NOW)).toBe(false)
  })

  it('true at or past the stale threshold', () => {
    expect(isMemoryStale(day(MEMORY_STALE_DAYS), NOW)).toBe(true)
    expect(isMemoryStale(day(MEMORY_STALE_DAYS + 10), NOW)).toBe(true)
  })

  it('false for unknown mtime (sentinel)', () => {
    expect(isMemoryStale(0, NOW)).toBe(false)
  })
})

describe('memoryAgeWarning', () => {
  it('returns empty string for today/fresh entries', () => {
    expect(memoryAgeWarning(NOW, NOW)).toBe('')
  })

  it('returns empty string for unknown mtime (sentinel)', () => {
    expect(memoryAgeWarning(0, NOW)).toBe('')
  })

  it('returns a warning at the old threshold', () => {
    const warning = memoryAgeWarning(day(MEMORY_OLD_DAYS), NOW)
    expect(warning).toContain(`${MEMORY_OLD_DAYS} day`)
    expect(warning).toContain('Verify identifiers')
  })

  it('uses singular "day" for a one-day-old entry', () => {
    const warning = memoryAgeWarning(day(1), NOW)
    expect(warning).toContain('1 day old')
    expect(warning).not.toContain('1 days old')
  })

  it('uses plural "days" past day one', () => {
    const warning = memoryAgeWarning(day(45), NOW)
    expect(warning).toContain('45 days old')
  })
})

describe('threshold values', () => {
  it('OLD_DAYS is below STALE_DAYS so the section-header signal is the higher gate', () => {
    expect(MEMORY_OLD_DAYS).toBeLessThan(MEMORY_STALE_DAYS)
  })
})
