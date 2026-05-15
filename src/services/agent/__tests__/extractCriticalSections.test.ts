import { extractCriticalSections, CRITICAL_SECTIONS_MAX_BYTES } from '../contextBuilder'

describe('extractCriticalSections', () => {
  it('extracts a "## CRITICAL: ..." H2 section with its body', () => {
    const md = [
      '# Skill',
      '',
      '## CRITICAL: Read first',
      'rule one',
      'rule two',
      '',
      '## Other section',
      'irrelevant body',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('CRITICAL: Read first')
    expect(out).toContain('rule one')
    expect(out).toContain('rule two')
    expect(out).not.toContain('Other section')
    expect(out).not.toContain('irrelevant body')
  })

  it('extracts a "## Hard rules" section', () => {
    const md = [
      '## Hard rules',
      '1. NEVER do X',
      '2. ALWAYS do Y',
      '',
      '## Setup',
      'setup body',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('NEVER do X')
    expect(out).toContain('ALWAYS do Y')
    expect(out).not.toContain('setup body')
  })

  it('extracts H3 CRITICAL subsections nested inside the H2 block', () => {
    const md = [
      '## CRITICAL: Top-level',
      'intro',
      '',
      '### CRITICAL — Wire the proxy',
      'rule A',
      '',
      '### CRITICAL — Never install firebase-admin',
      'rule B',
      '',
      '## Next section',
      'something else',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('rule A')
    expect(out).toContain('rule B')
    expect(out).not.toContain('something else')
  })

  it('extracts MULTIPLE H2 CRITICAL/Hard-rules sections', () => {
    const md = [
      '## CRITICAL: First block',
      'first body',
      '',
      '## Other',
      'skipped',
      '',
      '## Hard rules',
      'numbered rules',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('first body')
    expect(out).toContain('numbered rules')
    expect(out).not.toContain('skipped')
  })

  it('tolerates emoji-prefixed CRITICAL header (## ⚠️ CRITICAL ...)', () => {
    const md = [
      '## ⚠️ CRITICAL: Emoji prefix',
      'emoji-body',
      '',
      '## End',
      'after',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('emoji-body')
    expect(out).not.toContain('after')
  })

  it('tolerates bold-marker CRITICAL header (## **CRITICAL** ...)', () => {
    const md = [
      '## **CRITICAL** Bold',
      'bold-body',
      '',
      '## Footer',
      'footer-text',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('bold-body')
    expect(out).not.toContain('footer-text')
  })

  it('does NOT match a CRITICAL word that appears mid-line of a non-CRITICAL header', () => {
    const md = [
      '## Notes about CRITICAL paths',
      'not-extracted',
    ].join('\n')

    // Header text starts with "Notes", not CRITICAL — must NOT match.
    const out = extractCriticalSections(md)
    expect(out).toBe('')
  })

  it('does NOT cross H2 boundaries', () => {
    const md = [
      '## CRITICAL: A',
      'a-body',
      '## Section B',
      'b-body',
      '## CRITICAL: C',
      'c-body',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('a-body')
    expect(out).not.toContain('b-body')
    expect(out).toContain('c-body')
  })

  it('returns empty string when no CRITICAL or Hard rules sections exist', () => {
    const md = [
      '# Skill',
      '## Setup',
      'install dep',
      '## Usage',
      'call x',
    ].join('\n')

    expect(extractCriticalSections(md)).toBe('')
  })

  it('truncates long content to CRITICAL_SECTIONS_MAX_BYTES with named warning', () => {
    const filler = 'x'.repeat(CRITICAL_SECTIONS_MAX_BYTES + 1000)
    const md = `## CRITICAL: huge\n${filler}\n## end\n`

    const out = extractCriticalSections(md)
    // The truncation warning is bounded — it names the cap, the bytes
    // dropped, and the remediation. 400 chars is the empirical ceiling
    // after substituting the largest realistic numbers; the assertion
    // uses 500 to leave headroom without losing the regression value.
    const WARNING_MAX_BYTES = 500
    expect(out.length).toBeLessThanOrEqual(CRITICAL_SECTIONS_MAX_BYTES + WARNING_MAX_BYTES)
    expect(out).toContain('CRITICAL_SECTIONS_MAX_BYTES')
    expect(out).toContain('exceeded')
  })

  it('handles real-world auth-proxy-shaped content end-to-end', () => {
    // Mini reproduction of the actual skill's structure.
    const md = `---
name: auth-proxy
---

# Auth Proxy

## CRITICAL: Read these before writing any code

### CRITICAL — Wire the Vite dev proxy

When frontend and backend run on different ports, vite.config.ts MUST include the proxy.

### CRITICAL — Never install firebase-admin

There is no Admin SDK in this stack.

## Hard rules

1. NEVER install firebase-admin.
2. NEVER call request_credentials for Firebase.
3. ALWAYS call /api/auth/sync after a successful proxy signin.

## Endpoint surface to implement

POST /api/auth/proxy/signup ...
`
    const out = extractCriticalSections(md)
    expect(out).toContain('Wire the Vite dev proxy')
    expect(out).toContain('Never install firebase-admin')
    expect(out).toContain('NEVER call request_credentials')
    expect(out).not.toContain('Endpoint surface to implement')
    expect(out).not.toContain('POST /api/auth/proxy/signup')
  })
})
