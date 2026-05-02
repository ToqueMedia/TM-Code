import {
  findHashtagAtCursor,
  findHashtagTokenEnd,
  extractHashtags,
} from '../hashtagParser'

describe('findHashtagAtCursor', () => {
  it('detects hashtag at the start of input', () => {
    expect(findHashtagAtCursor('#auth-google', 12)).toEqual({
      hashIndex: 0,
      query: 'auth-google',
    })
  })

  it('detects hashtag with empty query (just #)', () => {
    expect(findHashtagAtCursor('#', 1)).toEqual({
      hashIndex: 0,
      query: '',
    })
  })

  it('detects hashtag mid-sentence after whitespace', () => {
    const text = 'add #auth-google now'
    // 'add ' = 0..3, '#' at 4, 'a'=5 'u'=6 't'=7 'h'=8 '-'=9 'g'=10 'o'=11
    expect(findHashtagAtCursor(text, 11)).toEqual({
      hashIndex: 4,
      query: 'auth-g',
    })
  })

  it('detects hashtag with cursor inside the token', () => {
    const text = '#auth-google'
    // cursor between 'auth' and '-'
    expect(findHashtagAtCursor(text, 5)).toEqual({
      hashIndex: 0,
      query: 'auth',
    })
  })

  it('returns null when # is preceded by a non-whitespace char (mid-word)', () => {
    expect(findHashtagAtCursor('foo#bar', 7)).toBeNull()
  })

  it('returns null when cursor is on a non-hashtag char before any #', () => {
    expect(findHashtagAtCursor('plain text', 5)).toBeNull()
  })

  it('returns null when there is no # before the cursor', () => {
    expect(findHashtagAtCursor('just words', 10)).toBeNull()
  })

  it('handles cursor past end of text gracefully', () => {
    expect(findHashtagAtCursor('#auth', 999)).toEqual({
      hashIndex: 0,
      query: 'auth',
    })
  })

  it('rejects # at the start of a word that follows another character', () => {
    // 'a#tag' — cursor at end. The '#' is preceded by 'a', not whitespace.
    expect(findHashtagAtCursor('a#tag', 5)).toBeNull()
  })

  it('handles hashtag with cursor right after #', () => {
    expect(findHashtagAtCursor('#', 1)).toEqual({
      hashIndex: 0,
      query: '',
    })
  })

  it('terminates token at whitespace going backward', () => {
    expect(findHashtagAtCursor('#auth-google now', 16)).toBeNull()
  })
})

describe('findHashtagTokenEnd', () => {
  it('finds end at whitespace', () => {
    expect(findHashtagTokenEnd('#auth-google now', 1)).toBe(12)
  })

  it('finds end at end-of-string', () => {
    expect(findHashtagTokenEnd('#auth-google', 1)).toBe(12)
  })

  it('handles hashtag with no body', () => {
    expect(findHashtagTokenEnd('# next', 1)).toBe(1)
  })
})

describe('extractHashtags', () => {
  it('extracts a single hashtag', () => {
    const result = extractHashtags('#auth-google')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      token: 'auth-google',
      start: 0,
      end: 12,
    })
  })

  it('extracts multiple hashtags', () => {
    const result = extractHashtags('add #auth-email-password and #auth-google now')
    expect(result.map(t => t.token)).toEqual(['auth-email-password', 'auth-google'])
  })

  it('ignores # mid-word (e.g. issue refs after a letter)', () => {
    expect(extractHashtags('see foo#1234')).toEqual([])
  })

  it('extracts hashtag at start of input', () => {
    const result = extractHashtags('#auth-google build it')
    expect(result).toHaveLength(1)
    expect(result[0].token).toBe('auth-google')
  })

  it('returns empty array for plain text', () => {
    expect(extractHashtags('no tags here')).toEqual([])
  })

  it('skips solo # with no body', () => {
    expect(extractHashtags('# alone')).toEqual([])
  })

  it('preserves correct start/end offsets for replacement', () => {
    const text = 'hi #foo bye'
    const tags = extractHashtags(text)
    expect(tags[0].start).toBe(3)
    expect(tags[0].end).toBe(7)
    expect(text.slice(tags[0].start, tags[0].end)).toBe('#foo')
  })
})
