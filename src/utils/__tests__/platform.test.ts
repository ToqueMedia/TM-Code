import { relativeToProjectPath } from '../platform'

describe('relativeToProjectPath', () => {
  it('returns a project-relative path for files inside the project root', () => {
    expect(relativeToProjectPath('/Users/me/app/src/App.tsx', '/Users/me/app')).toBe('src/App.tsx')
  })

  it('handles trailing slashes on the project root', () => {
    expect(relativeToProjectPath('/Users/me/app/package.json', '/Users/me/app/')).toBe('package.json')
  })

  it('normalizes windows separators and compares drive-letter paths case-insensitively', () => {
    expect(relativeToProjectPath('C:\\Users\\Me\\App\\src\\index.ts', 'c:/users/me/app')).toBe('src/index.ts')
  })

  it('returns dot when the path is the project root', () => {
    expect(relativeToProjectPath('/Users/me/app', '/Users/me/app')).toBe('.')
  })

  it('keeps outside paths absolute but normalized', () => {
    expect(relativeToProjectPath('/Users/me/other/file.ts', '/Users/me/app')).toBe('/Users/me/other/file.ts')
  })
})
