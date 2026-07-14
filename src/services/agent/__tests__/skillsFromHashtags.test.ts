// NOTE (2026-07): the `#auth-google` / `#auth-email-password` →
// auth-proxy/google-signin mappings (and their tests) were removed with the
// MANAGED-PLATFORM layer — managed auth provisioning lives in TM Code Web.
// `#design` → frontend-design is the remaining skill-trigger mapping; the
// former auth tags must behave like any unrecognised hashtag.
import { skillsFromHashtags } from '../contextBuilder'

// contextBuilder → contextPlanner → firebaseAuth, which reads
// import.meta.env at module load (Jest cannot parse import.meta). Stub it
// with the repo's established mock shape (see agentServiceRequestType.test.ts).
jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: jest.fn().mockResolvedValue('mock-firebase-token'),
    }),
  },
  getAppCheckHeader: jest.fn().mockResolvedValue({ 'X-Firebase-AppCheck': 'mock-appcheck' }),
}))

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

  it('detects #design → frontend-design', () => {
    const r = skillsFromHashtags('build a #design landing page')
    expect(r).toEqual(['frontend-design'])
  })

  it('treats the removed managed-auth tags as unrecognised', () => {
    expect(skillsFromHashtags('Add login with #auth-google please')).toEqual([])
    expect(skillsFromHashtags('add #auth-email-password signup')).toEqual([])
  })

  it('is case-insensitive for the tag body', () => {
    const r = skillsFromHashtags('#DESIGN')
    expect(r).toContain('frontend-design')
  })

  it('does NOT trigger when hashtag is part of a larger word (e.g. ###design in code)', () => {
    // The boundary requires whitespace or start-of-string before #.
    const r = skillsFromHashtags('a###design')
    expect(r).toEqual([])
  })

  it('deduplicates skills across multiple tag mentions', () => {
    const r = skillsFromHashtags('#design here and #design there')
    const occurrences = r.filter((s) => s === 'frontend-design').length
    expect(occurrences).toBe(1)
  })
})
