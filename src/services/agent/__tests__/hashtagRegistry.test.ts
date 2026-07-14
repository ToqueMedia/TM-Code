// NOTE (2026-07): the `detectAuthHashtags` describe block and all
// `#auth-email-password` / `#auth-google` expectations were removed with the
// MANAGED-PLATFORM layer (managed auth provisioning moved to TM Code Web).
// `#design` is the remaining registry tag; former auth tags must now pass
// through as plain text like any unknown hashtag.
import {
  HASHTAG_OPTIONS,
  filterHashtagOptions,
  preprocessHashtags,
} from '../hashtagRegistry'

describe('HASHTAG_OPTIONS', () => {
  it('contains the #design tag', () => {
    const tags = HASHTAG_OPTIONS.map(o => o.tag)
    expect(tags).toContain('#design')
  })

  it('no longer contains the managed auth tags', () => {
    const tags = HASHTAG_OPTIONS.map(o => o.tag)
    expect(tags).not.toContain('#auth-email-password')
    expect(tags).not.toContain('#auth-google')
  })
})

describe('filterHashtagOptions', () => {
  it('returns all options for empty query', () => {
    expect(filterHashtagOptions('')).toEqual(HASHTAG_OPTIONS)
  })

  it('filters by prefix on tag body (case-insensitive)', () => {
    const matches = filterHashtagOptions('des')
    expect(matches.map(m => m.tag)).toEqual(['#design'])
  })

  it('is case-insensitive', () => {
    expect(filterHashtagOptions('DES').map(m => m.tag)).toEqual(['#design'])
  })

  it('returns empty for non-matching query', () => {
    expect(filterHashtagOptions('payments')).toEqual([])
  })

  it('returns empty for the removed auth tags', () => {
    expect(filterHashtagOptions('auth')).toEqual([])
    expect(filterHashtagOptions('auth-g')).toEqual([])
  })
})

describe('preprocessHashtags', () => {
  it('returns unchanged text when no hashtags', () => {
    expect(preprocessHashtags('build a login screen')).toEqual({
      hasDesign: false,
      cleanedText: 'build a login screen',
    })
  })

  it('detects #design and strips it', () => {
    const result = preprocessHashtags('#design build a landing page')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('build a landing page')
  })

  it('deduplicates repeated tags', () => {
    const result = preprocessHashtags('#design and again #design')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('and again')
  })

  it('ignores unknown hashtags (passes them through)', () => {
    const result = preprocessHashtags('see #1234 and ship #urgent')
    expect(result.hasDesign).toBe(false)
    // Unknown tags are NOT stripped — only whitespace is potentially normalised
    expect(result.cleanedText).toContain('#1234')
    expect(result.cleanedText).toContain('#urgent')
  })

  it('treats the removed auth tags as unknown hashtags (pass-through)', () => {
    const result = preprocessHashtags('#auth-google build a login screen')
    expect(result.hasDesign).toBe(false)
    expect(result.cleanedText).toContain('#auth-google')
  })

  it('handles tag at the very start with no extra text', () => {
    const result = preprocessHashtags('#design')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('')
  })

  it('handles tag mid-word as plain text (does not strip)', () => {
    const result = preprocessHashtags('foo#design bar')
    // Mid-word `#` doesn't satisfy the whitespace rule of extractHashtags,
    // so the substring is left alone.
    expect(result.hasDesign).toBe(false)
    expect(result.cleanedText).toBe('foo#design bar')
  })

  it('handles multiline input with newline normalisation', () => {
    const result = preprocessHashtags('line one\n#design\nline two')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('line one\nline two')
  })

  it('case-insensitive #design', () => {
    const result = preprocessHashtags('#DESIGN make it bold')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('make it bold')
  })

  it('strips #design among unknown tags and keeps the unknowns', () => {
    const result = preprocessHashtags('see #issue-123 then #design')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toContain('#issue-123')
  })
})
