import { buildAppliedEditResultText } from '../toolExecutor/changedFileSnippet'

describe('buildAppliedEditResultText', () => {
  it('confirms an applied edit without re-sending file contents', () => {
    const appliedDiff = {
      path: '/project/AccountCode.tsx',
      oldContent: 'before',
      newContent: 'after',
    }
    const result = buildAppliedEditResultText(appliedDiff)

    expect(result).toBe('File updated: /project/AccountCode.tsx')
    expect(result).not.toContain('Resulting content')
    expect(result).not.toContain('before')
    expect(result).not.toContain('after')
  })

  it('identifies a new file', () => {
    expect(buildAppliedEditResultText({ path: '/project/new.ts', isNewFile: true }))
      .toBe('File created: /project/new.ts')
  })
})
