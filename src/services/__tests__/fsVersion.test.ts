import { getFsVersion, bumpFsVersion, subscribeFsVersion, __resetFsVersionForTests } from '../fsVersion'

// The fsVersion counter is the load-bearing piece for cache invalidation in
// both the system-prompt builder and the skill service. Regressions in this
// module silently revert turn N+1 to seeing a stale file tree — exactly the
// `helper.ts written, not visible next turn` bug. Pin the contract here so a
// future refactor can't break it without us noticing.

beforeEach(() => { __resetFsVersionForTests() })

describe('fsVersion', () => {
  test('starts at 0', () => {
    expect(getFsVersion()).toBe(0)
  })

  test('bump increments by exactly one', () => {
    bumpFsVersion()
    expect(getFsVersion()).toBe(1)
    bumpFsVersion()
    expect(getFsVersion()).toBe(2)
  })

  test('bump returns the new value', () => {
    expect(bumpFsVersion()).toBe(1)
    expect(bumpFsVersion()).toBe(2)
  })

  test('multiple bumps are strictly monotonic', () => {
    const seen: number[] = []
    for (let i = 0; i < 100; i++) seen.push(bumpFsVersion())
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1])
    }
  })

  test('reason argument is accepted but does not affect value', () => {
    bumpFsVersion('write:foo.ts')
    expect(getFsVersion()).toBe(1)
    bumpFsVersion()
    expect(getFsVersion()).toBe(2)
  })

  describe('subscribers', () => {
    test('fire on bump with the new value', () => {
      const seen: number[] = []
      subscribeFsVersion(v => seen.push(v))
      bumpFsVersion()
      bumpFsVersion()
      expect(seen).toEqual([1, 2])
    })

    test('unsubscribe stops further notifications', () => {
      const seen: number[] = []
      const unsub = subscribeFsVersion(v => seen.push(v))
      bumpFsVersion()
      unsub()
      bumpFsVersion()
      expect(seen).toEqual([1])
    })

    test('listener throwing does not break other listeners or the bump', () => {
      const seen: number[] = []
      subscribeFsVersion(() => { throw new Error('boom') })
      subscribeFsVersion(v => seen.push(v))
      expect(() => bumpFsVersion()).not.toThrow()
      expect(seen).toEqual([1])
      expect(getFsVersion()).toBe(1)
    })
  })
})
