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

  it('extracts an ORPHAN "### CRITICAL — ..." block under a non-critical H2', () => {
    // The auth-proxy skill puts MISSING_REQUEST_URI / providerId rules under
    // "## the auth API REST endpoints you'll call" — a non-critical H2 with
    // CRITICAL H3 children. Previously these were silently dropped.
    const md = [
      '## the auth API REST endpoints',
      'descriptive prose',
      '',
      '### CRITICAL — postBody + requestUri',
      'rule alpha',
      '',
      '### Some other H3',
      'unrelated',
      '',
      '### CRITICAL — providerId camelCase',
      'rule beta',
      '',
      '## Next section',
      'never',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('rule alpha')
    expect(out).toContain('rule beta')
    expect(out).not.toContain('descriptive prose')
    expect(out).not.toContain('unrelated')
    expect(out).not.toContain('never')
  })

  it('orphan H3 CRITICAL block ends at the next H3 (critical or not)', () => {
    const md = [
      '## Non-critical H2',
      '',
      '### CRITICAL — first',
      'first-body',
      '',
      '### Plain H3',
      'plain-body',
      '',
      '### CRITICAL — second',
      'second-body',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('first-body')
    expect(out).toContain('second-body')
    expect(out).not.toContain('plain-body')
  })

  it('orphan H3 CRITICAL block closes at the next H2 (does not bleed into siblings)', () => {
    const md = [
      '## Non-critical A',
      '### CRITICAL — orphan A',
      'orphan-body',
      '## Non-critical B',
      'sibling-body',
    ].join('\n')

    const out = extractCriticalSections(md)
    expect(out).toContain('orphan-body')
    expect(out).not.toContain('sibling-body')
  })

  it('handles real-world auth-proxy-shaped content end-to-end', () => {
    // Mini reproduction of the actual skill's structure — includes orphan
    // ### CRITICAL — H3 blocks under a non-critical H2 ("## the auth API
    // REST endpoints"), which is where the MISSING_REQUEST_URI rule lives.
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

## the auth API REST endpoints you'll call

Top-level descriptive content that should NOT be in the slice.

### CRITICAL — \`signInWithIdp\` requires \`postBody\` + \`requestUri\`

Pass body shape requestUri detail goes here.

### CRITICAL — \`postBody\` uses \`providerId\` (camelCase)

The camelCase rule that catches INVALID_CREDENTIAL_OR_PROVIDER_ID.

## Error mapping

EMAIL_EXISTS → 409
`
    const out = extractCriticalSections(md)
    expect(out).toContain('Wire the Vite dev proxy')
    expect(out).toContain('Never install firebase-admin')
    expect(out).toContain('NEVER call request_credentials')
    // Orphan H3 critical blocks must be captured too (the regression this
    // section guards against).
    expect(out).toContain('signInWithIdp')
    expect(out).toContain('requestUri detail goes here')
    expect(out).toContain('camelCase rule that catches INVALID_CREDENTIAL_OR_PROVIDER_ID')
    // Non-critical content (between orphans and after) must NOT bleed in.
    expect(out).not.toContain('Endpoint surface to implement')
    expect(out).not.toContain('POST /api/auth/proxy/signup')
    expect(out).not.toContain('Top-level descriptive content')
    expect(out).not.toContain('EMAIL_EXISTS → 409')
  })
})
