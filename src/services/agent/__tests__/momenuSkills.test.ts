import {
  isMomenuSkill,
  fetchMomenuSkill,
  fetchAllMomenuSkills,
  MOMENU_SKILLS_BASE,
} from '../momenuSkills'

// Helper: build a fetch mock that resolves text by URL suffix; unmatched → 404.
function mockFetchByUrl(resolver: (url: string) => string | number) {
  global.fetch = jest.fn(async (url: string) => {
    const out = resolver(url)
    if (typeof out === 'number') return { ok: false, status: out } as unknown as Response
    return { ok: true, status: 200, text: async () => out } as unknown as Response
  }) as unknown as typeof fetch
}

describe('momenuSkills', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('isMomenuSkill recognises the remote catalog only', () => {
    expect(isMomenuSkill('mom-factura-payments')).toBe(true)
    expect(isMomenuSkill('mom-factura-webhooks')).toBe(true)
    expect(isMomenuSkill('mom-factura-testing')).toBe(true)
    expect(isMomenuSkill('react-patterns')).toBe(false)
    expect(isMomenuSkill('auth-proxy')).toBe(false)
  })

  it('fetchMomenuSkill returns null for an unknown skill WITHOUT hitting the network', async () => {
    const spy = jest.fn()
    global.fetch = spy as unknown as typeof fetch
    expect(await fetchMomenuSkill('not-a-skill')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('fetchMomenuSkill pulls SKILL.md + references fresh from `main`', async () => {
    mockFetchByUrl((url) => {
      if (url.endsWith('/mom-factura-payments/SKILL.md')) return '# Payments body'
      if (url.endsWith('/mom-factura-payments/references/STATUS-POLLING.md')) return 'polling ref'
      return 404
    })

    const skill = await fetchMomenuSkill('mom-factura-payments')
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('mom-factura-payments')
    expect(skill!.content).toBe('# Payments body')
    expect(skill!.references).toHaveLength(1)
    expect(skill!.references[0]).toContain('references/STATUS-POLLING.md')
    expect(skill!.references[0]).toContain('polling ref')

    // Always the latest `main` revision (no version pin, no app cache).
    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string
    expect(firstUrl.startsWith(MOMENU_SKILLS_BASE)).toBe(true)
    expect(firstUrl).toContain('/momenu-skills/main/skills/')
  })

  it('fetchMomenuSkill returns null when SKILL.md is unavailable', async () => {
    mockFetchByUrl(() => 404)
    expect(await fetchMomenuSkill('mom-factura-webhooks')).toBeNull()
  })

  it('fetchMomenuSkill keeps the body but omits a reference that fails', async () => {
    mockFetchByUrl((url) => (url.endsWith('SKILL.md') ? 'body' : 500))
    const skill = await fetchMomenuSkill('mom-factura-payments')
    expect(skill!.content).toBe('body')
    expect(skill!.references).toHaveLength(0)
  })

  it('fetchAllMomenuSkills concatenates <skill> blocks for /payments', async () => {
    mockFetchByUrl((url) => {
      if (url.endsWith('STATUS-POLLING.md')) return 'REF'
      if (url.endsWith('SKILL.md')) return 'BODY'
      return 404
    })

    const all = await fetchAllMomenuSkills()
    expect(all).toContain('<skill name="mom-factura-payments">')
    expect(all).toContain('BODY')
    expect(all).toContain('<skill name="mom-factura-payments/references/STATUS-POLLING.md">')
    expect(all).toContain('REF')
    expect(all).toContain('<skill name="mom-factura-webhooks">')
  })

  it('fetchAllMomenuSkills returns empty string when every fetch fails', async () => {
    mockFetchByUrl(() => 404)
    expect(await fetchAllMomenuSkills()).toBe('')
  })
})
