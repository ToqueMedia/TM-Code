import { emptySessionPeriod } from '../emptySessionPeriod'

describe('emptySessionPeriod', () => {
  it('maps clock hours to greeting bands', () => {
    expect(emptySessionPeriod(5)).toBe('morning')
    expect(emptySessionPeriod(11)).toBe('morning')
    expect(emptySessionPeriod(12)).toBe('afternoon')
    expect(emptySessionPeriod(17)).toBe('afternoon')
    expect(emptySessionPeriod(18)).toBe('evening')
    expect(emptySessionPeriod(0)).toBe('evening')
    expect(emptySessionPeriod(4)).toBe('evening')
  })
})
