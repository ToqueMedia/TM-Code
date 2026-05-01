import {
  HASHTAG_OPTIONS,
  filterHashtagOptions,
  detectAuthHashtags,
  preprocessHashtags,
} from '../hashtagRegistry'

describe('HASHTAG_OPTIONS', () => {
  it('contains both auth provider tags', () => {
    const tags = HASHTAG_OPTIONS.map(o => o.tag)
    expect(tags).toContain('#auth-email-password')
    expect(tags).toContain('#auth-google')
  })

  it('contains the #design tag', () => {
    const tags = HASHTAG_OPTIONS.map(o => o.tag)
    expect(tags).toContain('#design')
  })
})

describe('filterHashtagOptions', () => {
  it('returns all options for empty query', () => {
    expect(filterHashtagOptions('')).toEqual(HASHTAG_OPTIONS)
  })

  it('filters by prefix on tag body (case-insensitive)', () => {
    const matches = filterHashtagOptions('auth-g')
    expect(matches.map(m => m.tag)).toEqual(['#auth-google'])
  })

  it('matches "auth-e" to email-password', () => {
    const matches = filterHashtagOptions('auth-e')
    expect(matches.map(m => m.tag)).toEqual(['#auth-email-password'])
  })

  it('matches both when query is "auth"', () => {
    const matches = filterHashtagOptions('auth')
    expect(matches.map(m => m.tag).sort()).toEqual([
      '#auth-email-password',
      '#auth-google',
    ])
  })

  it('returns empty for non-matching query', () => {
    expect(filterHashtagOptions('payments')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(filterHashtagOptions('AUTH-G').map(m => m.tag)).toEqual(['#auth-google'])
  })
})

describe('detectAuthHashtags', () => {
  it('returns empty providers and unchanged text when no hashtags', () => {
    expect(detectAuthHashtags('build a login screen')).toEqual({
      providers: [],
      cleanedText: 'build a login screen',
    })
  })

  it('detects #auth-google and strips it', () => {
    const result = detectAuthHashtags('#auth-google build a login screen')
    expect(result.providers).toEqual(['google'])
    expect(result.cleanedText).toBe('build a login screen')
  })

  it('detects #auth-email-password and strips it', () => {
    const result = detectAuthHashtags('add #auth-email-password please')
    expect(result.providers).toEqual(['email-password'])
    expect(result.cleanedText).toBe('add  please'.replace(/[ \t]+/g, ' ').trim())
    // Whitespace collapse: "add  please" → "add please"
    expect(result.cleanedText).toBe('add please')
  })

  it('detects both providers when both tags are present', () => {
    const result = detectAuthHashtags('#auth-email-password #auth-google ship it')
    expect(result.providers.sort()).toEqual(['email-password', 'google'])
    expect(result.cleanedText).toBe('ship it')
  })

  it('deduplicates repeated tags into a single provider', () => {
    const result = detectAuthHashtags('#auth-google and again #auth-google')
    expect(result.providers).toEqual(['google'])
    expect(result.cleanedText).toBe('and again')
  })

  it('ignores unknown hashtags (passes them through)', () => {
    const result = detectAuthHashtags('see #1234 and ship #urgent')
    expect(result.providers).toEqual([])
    // Unknown tags are NOT stripped — only whitespace is potentially normalised
    expect(result.cleanedText).toContain('#1234')
    expect(result.cleanedText).toContain('#urgent')
  })

  it('handles tag at the very start with no extra text', () => {
    const result = detectAuthHashtags('#auth-google')
    expect(result.providers).toEqual(['google'])
    expect(result.cleanedText).toBe('')
  })

  it('handles tag mid-word as plain text (does not strip)', () => {
    const result = detectAuthHashtags('email#auth-google here')
    // Mid-word `#` doesn't satisfy the whitespace rule of extractHashtags,
    // so the substring is left alone.
    expect(result.providers).toEqual([])
    expect(result.cleanedText).toBe('email#auth-google here')
  })

  it('handles multiline input with newline normalisation', () => {
    const result = detectAuthHashtags('line one\n#auth-google\nline two')
    expect(result.providers).toEqual(['google'])
    expect(result.cleanedText).toBe('line one\nline two')
  })

  it('preserves order-independence in provider detection', () => {
    const a = detectAuthHashtags('#auth-google #auth-email-password')
    const b = detectAuthHashtags('#auth-email-password #auth-google')
    expect(a.providers.sort()).toEqual(b.providers.sort())
  })
})

describe('preprocessHashtags — combined auth + design detection', () => {
  it('detects #design alone', () => {
    const result = preprocessHashtags('#design build a landing page')
    expect(result.authProviders).toEqual([])
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('build a landing page')
  })

  it('detects #design + auth combined', () => {
    const result = preprocessHashtags('#auth-google #design build login')
    expect(result.authProviders).toEqual(['google'])
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('build login')
  })

  it('returns hasDesign:false when only auth tags present', () => {
    const result = preprocessHashtags('#auth-google login')
    expect(result.authProviders).toEqual(['google'])
    expect(result.hasDesign).toBe(false)
    expect(result.cleanedText).toBe('login')
  })

  it('case-insensitive #design', () => {
    const result = preprocessHashtags('#DESIGN make it bold')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toBe('make it bold')
  })

  it('passes unknown tags through untouched', () => {
    const result = preprocessHashtags('see #issue-123 then #design')
    expect(result.hasDesign).toBe(true)
    expect(result.cleanedText).toContain('#issue-123')
  })

  it('ignores mid-word #design (whitespace rule)', () => {
    const result = preprocessHashtags('foo#design bar')
    expect(result.hasDesign).toBe(false)
    expect(result.cleanedText).toBe('foo#design bar')
  })

  it('detectAuthHashtags still works (legacy API)', () => {
    // Ensure the legacy entry point still returns auth-only result.
    const result = detectAuthHashtags('#auth-google #design build')
    expect(result.providers).toEqual(['google'])
    // The cleanedText comes from preprocess which strips ALL known tags.
    expect(result.cleanedText).toBe('build')
  })
})
