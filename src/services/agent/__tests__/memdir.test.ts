import {
  buildMemoryFileContent,
  defaultScopeForType,
  memoryFilenameFor,
  parseFrontmatter,
  parseIndexEntries,
  projectIndexEntries,
} from '../memdir'

describe('parseIndexEntries', () => {
  it('parses canonical bullet lines', () => {
    const index = [
      '# Memory Index',
      '',
      '- [user-role](user_role.md) — Developer is a Go backend dev new to React',
      '- [no-outlines](feedback_no-outlines.md) — User wants no focus rings on UI',
      '- [deploy-target](project_deploy-target.md) — Cloudflare-only pipeline',
    ].join('\n')

    const entries = parseIndexEntries(index)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      name: 'user-role',
      type: 'user',
      description: 'Developer is a Go backend dev new to React',
      filename: 'user_role.md',
    })
    expect(entries[1].type).toBe('feedback')
    expect(entries[2].type).toBe('project')
  })

  it('skips headers, blank lines, and the truncation warning footer', () => {
    const index = [
      '# Memory Index',
      '',
      '- [a](user_a.md) — first',
      '',
      '> ⚠️ MEMORY.md MAX_ENTRYPOINT_LINES exceeded. Only part of it was loaded.',
    ].join('\n')

    const entries = parseIndexEntries(index)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('a')
  })

  it('classifies type from filename prefix', () => {
    const index = [
      '- [x](reference_x.md) — ref',
      '- [y](feedback_y.md) — feed',
      '- [z](weird_z.md) — defaults to project',
    ].join('\n')

    const entries = parseIndexEntries(index)
    expect(entries.map(e => e.type)).toEqual(['reference', 'feedback', 'project'])
  })

  it('attaches mtimes when provided', () => {
    const index = '- [a](user_a.md) — first'
    const mtimes = new Map<string, number>([['user_a.md', 1_700_000_000_000]])
    const [entry] = parseIndexEntries(index, mtimes)
    expect(entry.mtimeMs).toBe(1_700_000_000_000)
  })

  it('returns mtimeMs=0 when caller omits mtimes', () => {
    const [entry] = parseIndexEntries('- [a](user_a.md) — first')
    expect(entry.mtimeMs).toBe(0)
  })
})

describe('projectIndexEntries', () => {
  const indexWithThree = [
    '# Memory Index',
    '',
    '- [keep-1](user_keep1.md) — relevant',
    '- [drop](user_drop.md) — irrelevant',
    '- [keep-2](feedback_keep2.md) — also relevant',
  ].join('\n')

  it('drops bullet lines whose names are not in the keep set', () => {
    const out = projectIndexEntries(indexWithThree, new Set(['keep-1', 'keep-2']))
    expect(out).toContain('keep-1')
    expect(out).toContain('keep-2')
    expect(out).not.toContain('drop')
  })

  it('preserves the index header', () => {
    const out = projectIndexEntries(indexWithThree, new Set(['keep-1']))
    expect(out).toContain('# Memory Index')
  })

  it('preserves the truncation warning footer when present', () => {
    const withWarning = [
      indexWithThree,
      '',
      '> ⚠️ MEMORY.md MAX_ENTRYPOINT_BYTES exceeded.',
    ].join('\n')
    const out = projectIndexEntries(withWarning, new Set(['keep-1']))
    expect(out).toContain('> ⚠️')
  })

  it('returns just the header when no names match', () => {
    const out = projectIndexEntries(indexWithThree, new Set(['nope']))
    expect(parseIndexEntries(out)).toHaveLength(0)
    expect(out).toContain('# Memory Index')
  })
})

describe('parseFrontmatter', () => {
  it('extracts name, description, and metadata.type', () => {
    const raw = [
      '---',
      'name: no-emojis',
      'description: User dislikes emojis in code',
      'metadata:',
      '  type: feedback',
      '---',
      '',
      'Avoid emojis.',
      '',
      '**Why:** they break some terminals.',
    ].join('\n')

    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter).toEqual({
      name: 'no-emojis',
      description: 'User dislikes emojis in code',
      type: 'feedback',
    })
    expect(body).toContain('Avoid emojis.')
  })

  it('returns null frontmatter for files without a `---` opener', () => {
    const raw = 'just markdown\nno frontmatter'
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter).toBeNull()
    expect(body).toBe(raw)
  })

  it('returns null frontmatter when required fields are missing', () => {
    const raw = ['---', 'name: incomplete', '---', '', 'body'].join('\n')
    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter).toBeNull()
  })

  it('returns null frontmatter for invalid type values', () => {
    const raw = [
      '---',
      'name: x',
      'description: y',
      'metadata:',
      '  type: bogus',
      '---',
      '',
      'body',
    ].join('\n')
    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter).toBeNull()
  })

  it('roundtrips with buildMemoryFileContent', () => {
    const fm = {
      name: 'rt',
      description: 'roundtrip',
      type: 'project' as const,
    }
    const content = buildMemoryFileContent(fm, 'body text')
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual(fm)
    expect(body.trim()).toBe('body text')
  })
})

describe('memoryFilenameFor', () => {
  it('prefixes with type and slugifies the name', () => {
    expect(memoryFilenameFor('user', 'Developer Role')).toBe('user_developer-role.md')
    expect(memoryFilenameFor('feedback', 'no_outlines!!')).toBe('feedback_no-outlines.md')
  })

  it('caps the slug at 60 chars', () => {
    const long = 'a'.repeat(120)
    const name = memoryFilenameFor('project', long)
    // 'project_' (8) + 60 + '.md' (3) = 71
    expect(name).toHaveLength(71)
  })
})

describe('defaultScopeForType', () => {
  it('routes user and feedback to user scope, project and reference to project scope', () => {
    expect(defaultScopeForType('user')).toBe('user')
    expect(defaultScopeForType('feedback')).toBe('user')
    expect(defaultScopeForType('project')).toBe('project')
    expect(defaultScopeForType('reference')).toBe('project')
  })
})
