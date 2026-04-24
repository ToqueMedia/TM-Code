import { compareSemver } from '../semver'

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('0.3.0', '0.3.0')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('returns -1 when left is older', () => {
    expect(compareSemver('0.2.2', '0.3.0')).toBe(-1)
    expect(compareSemver('0.3.0', '0.3.1')).toBe(-1)
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1)
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
  })

  it('returns 1 when left is newer', () => {
    expect(compareSemver('0.3.1', '0.3.0')).toBe(1)
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1)
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0)
    expect(compareSemver('1.2', '1.2.0')).toBe(0)
    expect(compareSemver('1.2', '1.2.1')).toBe(-1)
  })

  it('ignores pre-release suffixes when comparing the core triple', () => {
    // Pre-release is IGNORED for update-banner reconciliation: a build that
    // shipped as "0.3.1-beta.1" should still be considered >= 0.3.1 so the
    // banner for 0.3.1 doesn't resurrect on users running the beta.
    expect(compareSemver('0.3.1-beta.1', '0.3.1')).toBe(0)
    expect(compareSemver('0.3.0-rc.1', '0.3.1')).toBe(-1)
  })

  it('handles malformed segments defensively', () => {
    expect(compareSemver('', '0.0.0')).toBe(0)
    expect(compareSemver('abc', 'def')).toBe(0)
  })
})
