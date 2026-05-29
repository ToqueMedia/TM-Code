import { globToRegex, matchesAccessedPaths } from '../memdir'

describe('globToRegex', () => {
  it('src/** matches any path under src/', () => {
    const rx = globToRegex('src/**')
    expect(rx.test('src/anything/deeply/nested')).toBe(true)
    expect(rx.test('src/file.ts')).toBe(true)
    expect(rx.test('src/')).toBe(true) // trailing slash — ** matches zero chars
    expect(rx.test('other/file.ts')).toBe(false)
  })

  it('**/test matches test at any depth', () => {
    const rx = globToRegex('**/test')
    expect(rx.test('deep/nested/test')).toBe(true)
    expect(rx.test('test')).toBe(true) // **/ is optional
    expect(rx.test('test/something')).toBe(false)
  })

  it('src/**/*.ts matches .ts files at any depth under src/', () => {
    const rx = globToRegex('src/**/*.ts')
    expect(rx.test('src/file.ts')).toBe(true) // direct child
    expect(rx.test('src/a/b/file.ts')).toBe(true) // nested
    expect(rx.test('src/a/b/file.js')).toBe(false) // wrong extension
    expect(rx.test('other/file.ts')).toBe(false) // wrong root
  })

  it('src/* matches only direct children of src/', () => {
    const rx = globToRegex('src/*')
    expect(rx.test('src/file.ts')).toBe(true)
    expect(rx.test('src/a/file.ts')).toBe(false) // nested — * doesn't cross /
  })

  it('handles patterns with dots', () => {
    const rx = globToRegex('src/auth/**')
    expect(rx.test('src/auth/login.ts')).toBe(true)
    expect(rx.test('src/auth/models/user.ts')).toBe(true)
  })
})

describe('matchesAccessedPaths', () => {
  it('returns true when patterns is undefined', () => {
    expect(matchesAccessedPaths(undefined, ['src/file.ts'])).toBe(true)
  })

  it('returns true when patterns is empty', () => {
    expect(matchesAccessedPaths([], ['src/file.ts'])).toBe(true)
  })

  it('returns true when accessedPaths is empty but patterns exist', () => {
    // No files accessed yet (turn 1) — don't filter
    expect(matchesAccessedPaths(['src/auth/**'], [])).toBe(true)
  })

  it('returns true when at least one accessed path matches', () => {
    expect(matchesAccessedPaths(
      ['src/auth/**', 'src/api/**'],
      ['src/auth/login.ts', 'src/other/file.ts'],
    )).toBe(true)
  })

  it('returns false when no accessed paths match', () => {
    expect(matchesAccessedPaths(
      ['src/auth/**'],
      ['src/api/routes.ts', 'src/ui/Button.tsx'],
    )).toBe(false)
  })
})
