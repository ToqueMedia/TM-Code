import { skillsFromHashtags } from '../contextBuilder'

describe('skillsFromHashtags', () => {
  it('returns empty for undefined or empty messages', () => {
    expect(skillsFromHashtags(undefined)).toEqual([])
    expect(skillsFromHashtags('')).toEqual([])
    expect(skillsFromHashtags('   ')).toEqual([])
  })

  it('returns empty for messages with no recognised hashtags', () => {
    expect(skillsFromHashtags('Build me an app')).toEqual([])
    expect(skillsFromHashtags('See issue #123 for context')).toEqual([])
    expect(skillsFromHashtags('#random tag, #unknown-feature')).toEqual([])
  })

  it('detects #auth-google → auth-proxy + google-signin', () => {
    const r = skillsFromHashtags('Add login with #auth-google please')
    expect(r).toContain('auth-proxy')
    expect(r).toContain('google-signin')
  })

  it('detects #auth-email-password → auth-proxy only (no google)', () => {
    const r = skillsFromHashtags('add #auth-email-password signup')
    expect(r).toContain('auth-proxy')
    expect(r).not.toContain('google-signin')
  })

  it('detects #design → frontend-design', () => {
    const r = skillsFromHashtags('build a #design landing page')
    expect(r).toEqual(['frontend-design'])
  })

  it('combines multiple recognised tags', () => {
    const r = skillsFromHashtags('Make it pretty #design and add #auth-google')
    expect(r).toContain('auth-proxy')
    expect(r).toContain('google-signin')
    expect(r).toContain('frontend-design')
  })

  it('is case-insensitive for the tag body', () => {
    const r = skillsFromHashtags('#Auth-Google #DESIGN')
    expect(r).toContain('auth-proxy')
    expect(r).toContain('google-signin')
    expect(r).toContain('frontend-design')
  })

  it('does NOT trigger when hashtag is part of a larger word (e.g. ###auth-google in code)', () => {
    // The boundary requires whitespace or start-of-string before #.
    const r = skillsFromHashtags('a###auth-google')
    expect(r).toEqual([])
  })

  it('matches the BugHunterKimi initial prompt', () => {
    const prompt =
      'Vamos criar uma plataforma que recebe dos testers (previamente registado com #auth-google) ' +
      'informações de bugs.'
    const r = skillsFromHashtags(prompt)
    expect(r).toContain('auth-proxy')
    expect(r).toContain('google-signin')
  })

  it('deduplicates skills across multiple tag mentions', () => {
    // #auth-google maps to BOTH auth-proxy AND google-signin; if also
    // present alongside #auth-email-password, auth-proxy should appear
    // once, not twice.
    const r = skillsFromHashtags('#auth-google and #auth-email-password')
    const occurrences = r.filter((s) => s === 'auth-proxy').length
    expect(occurrences).toBe(1)
  })
})
