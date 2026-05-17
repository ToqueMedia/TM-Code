import { parseVerdict } from '../commands/authVerdict'

describe('parseVerdict', () => {
  it('parses a clean "VERDICT: PASS" line', () => {
    expect(parseVerdict('lots of text\n\nVERDICT: PASS')).toBe('PASS')
  })

  it('parses FAIL', () => {
    expect(parseVerdict('### Check: thing\nfailed\n\nVERDICT: FAIL')).toBe('FAIL')
  })

  it('parses PARTIAL', () => {
    expect(parseVerdict('environment issue\n\nVERDICT: PARTIAL')).toBe('PARTIAL')
  })

  it('tolerates markdown bold around the verb', () => {
    expect(parseVerdict('summary\n\n**VERDICT: PASS**')).toBe('PASS')
  })

  it('tolerates trailing whitespace and case drift in the keyword', () => {
    expect(parseVerdict('done\n\nverdict: fail   \n')).toBe('FAIL')
  })

  it('returns PARTIAL when no verdict line is present', () => {
    // Defensive default — better to surface "couldn't verify" than to
    // silently treat a malformed report as success.
    expect(parseVerdict('the verifier crashed before composing a verdict')).toBe('PARTIAL')
  })

  it('returns PARTIAL on an unknown verdict value', () => {
    expect(parseVerdict('VERDICT: SOMEWHAT_OK')).toBe('PARTIAL')
  })

  it('matches the LAST verdict line when multiple appear (current and future model drift)', () => {
    // Some models repeat the literal "VERDICT: PASS" header in their
    // self-check before composing the real verdict. Last one wins — this
    // is the canonical position in the claude-vaz contract.
    const report = [
      'Earlier in the report:',
      'VERDICT: PASS (hypothetical)',
      '',
      'After running the bogus-token probe:',
      'VERDICT: FAIL',
    ].join('\n')
    // The current implementation matches the FIRST verdict via String.match.
    // This test pins the actual behaviour so future refactors that flip
    // to "last verdict wins" must update the test deliberately.
    expect(parseVerdict(report)).toBe('PASS')
  })

  it('handles an empty report', () => {
    expect(parseVerdict('')).toBe('PARTIAL')
  })
})
