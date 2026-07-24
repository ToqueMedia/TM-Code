import { formatGitStatusDomain } from '../domainFormats'

describe('domainFormats', () => {
  it('formats git status as TSV without pulling TOON', () => {
    expect(
      formatGitStatusDomain([
        { path: 'a.ts', status: 'M', staged: true },
        { path: 'b.ts', status: 'D' },
      ]),
    ).toBe('M\ta.ts\tstaged\nD\tb.ts\tunstaged')
  })
})
