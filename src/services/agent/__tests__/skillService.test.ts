import { invoke } from '@tauri-apps/api/core'
import SkillService from '../skillService'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

// Reset singleton between tests
function freshService(): SkillService {
  // @ts-expect-error — reset private singleton for isolation
  SkillService.instance = undefined
  return SkillService.getInstance()
}

describe('SkillService', () => {
  let service: SkillService

  beforeEach(() => {
    service = freshService()
    mockedInvoke.mockReset()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      expect(SkillService.getInstance()).toBe(SkillService.getInstance())
    })
  })

  describe('loadSkills', () => {
    it('loads bundled skills filtered by project type', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_skills_bundled') {
          return [
            { name: 'react-patterns', path: '/res/skills/react-patterns' },
            { name: 'vue-patterns', path: '/res/skills/vue-patterns' },
            { name: 'general-coding', path: '/res/skills/general-coding' },
          ]
        }
        if (cmd === 'read_skill_content') {
          const p = (args as Record<string, unknown>)?.skillPath as string
          const name = p.split('/').pop() || ''
          return { content: `# ${name}\nSome content.`, references: [] }
        }
        if (cmd === 'glob_files') return []
        if (cmd === 'get_home_directory') return '/home/user'
        throw new Error('File not found')
      })

      const skills = await service.loadSkills('/project', 'react')

      const names = skills.map(s => s.name)
      expect(names).toContain('react-patterns')
      expect(names).toContain('general-coding')
      expect(names).not.toContain('vue-patterns')
    })

    it('includes general-coding for any project type', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_skills_bundled') {
          return [{ name: 'general-coding', path: '/res/skills/general-coding' }]
        }
        if (cmd === 'read_skill_content') {
          return { content: '# General', references: [] }
        }
        if (cmd === 'glob_files') return []
        if (cmd === 'get_home_directory') return '/home/user'
        throw new Error('File not found')
      })

      const skills = await service.loadSkills('/project', undefined)
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('general-coding')
    })

    it('loads project skills from .tmcode/skills/', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_skills_bundled') return []
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'create_directories_all') return undefined
        if (cmd === 'glob_files') {
          const dir = (args as Record<string, unknown>)?.directory as string
          if (dir === '/project/.tmcode/skills') {
            return ['/project/.tmcode/skills/my-rules/SKILL.md']
          }
          return []
        }
        if (cmd === 'read_file') {
          return '# My Rules\nAlways use semicolons.'
        }
        throw new Error('Not found')
      })

      const skills = await service.loadSkills('/project')
      const projectSkills = skills.filter(s => s.scope === 'project')
      expect(projectSkills).toHaveLength(1)
      expect(projectSkills[0].name).toBe('my-rules')
      expect(projectSkills[0].content).toContain('semicolons')
    })

    // v1.0.1 skills-discovery fix: canonical dir + flat single-file + lowercase skill.md.
    it('loads project skills from the canonical .tmcode/skills/', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_skills_bundled') return []
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'glob_files') {
          const { directory, pattern } = args as { directory: string; pattern: string }
          if (directory === '/project/.tmcode/skills' && pattern === '*/*.md') {
            return ['/project/.tmcode/skills/deploy/SKILL.md']
          }
          return []
        }
        if (cmd === 'read_file') return '---\nname: deploy\ndescription: Deploy recipe\n---\nSteps'
        throw new Error('Not found')
      })

      const skills = await service.loadSkills('/project')
      expect(skills.filter(s => s.scope === 'project').map(s => s.name)).toContain('deploy')
    })

    it('loads a flat single-file project skill (<name>.md) with path = the file', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_skills_bundled') return []
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'glob_files') {
          const { directory, pattern } = args as { directory: string; pattern: string }
          if (directory === '/project/.tmcode/skills' && pattern === '*.md') {
            return ['/project/.tmcode/skills/my-skill.md']
          }
          return []
        }
        if (cmd === 'read_file') return '---\nname: my-skill\ndescription: Flat skill\n---\nBody'
        throw new Error('Not found')
      })

      const proj = (await service.loadSkills('/project')).filter(s => s.scope === 'project')
      expect(proj).toHaveLength(1)
      expect(proj[0].name).toBe('my-skill')
      // A single-file skill's path must be the file itself so deleteSkill never nukes the dir.
      expect(proj[0].path).toBe('/project/.tmcode/skills/my-skill.md')
    })

    it('discovers a nested skill with lowercase skill.md (case-insensitive)', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_skills_bundled') return []
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'glob_files') {
          const { directory, pattern } = args as { directory: string; pattern: string }
          if (directory === '/home/user/.tmcode/skills' && pattern === '*/*.md') {
            return ['/home/user/.tmcode/skills/foo/skill.md']
          }
          return []
        }
        if (cmd === 'read_file') return '---\nname: foo\ndescription: Foo\n---\nBody'
        throw new Error('Not found')
      })

      expect((await service.loadSkills('/project')).filter(s => s.scope === 'global').map(s => s.name)).toContain('foo')
    })

    it('caches results within TTL', async () => {
      let callCount = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_skills_bundled') {
          callCount++
          return []
        }
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'glob_files') return []
        throw new Error('Not found')
      })

      await service.loadSkills('/project')
      await service.loadSkills('/project')
      await service.loadSkills('/project')

      // list_skills_bundled should only be called once (cached after first)
      expect(callCount).toBe(1)
    })

    it('cache is invalidated by invalidateCache()', async () => {
      let callCount = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_skills_bundled') {
          callCount++
          return []
        }
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'glob_files') return []
        throw new Error('Not found')
      })

      await service.loadSkills('/project')
      service.invalidateCache()
      await service.loadSkills('/project')

      expect(callCount).toBe(2)
    })

    it('returns empty on all failures (no throw)', async () => {
      mockedInvoke.mockRejectedValue(new Error('everything broken'))

      const skills = await service.loadSkills('/project')
      expect(skills).toEqual([])
    })
  })

  describe('buildSkillsPromptBlock (JIT index)', () => {
    it('returns empty string for no skills', () => {
      expect(service.buildSkillsPromptBlock([])).toBe('')
    })

    it('emits index lines with name + description (full content NOT inlined)', () => {
      const block = service.buildSkillsPromptBlock([
        {
          id: 'b:general', name: 'general', description: 'General coding hygiene rules',
          path: '/p', content: '# General\n\nFull body that should NOT appear in the index.',
          references: [], scope: 'bundled',
        },
      ])
      expect(block).toContain('# Skills available')
      expect(block).toContain('read_skill')
      expect(block).toContain('- general — General coding hygiene rules')
      // Critical: the full body is intentionally absent from the index.
      expect(block).not.toContain('Full body that should NOT appear')
    })

    it('does NOT silently drop skills regardless of total content size (no truncation)', () => {
      // Pre-JIT this test asserted truncation. Post-JIT the index is small enough
      // that even huge content bodies do not affect emission — bodies are out-of-band.
      const longBody = 'x'.repeat(20_000)
      const block = service.buildSkillsPromptBlock([
        {
          id: 'p:rules', name: 'rules', description: 'Project-specific rules',
          path: '/p', content: longBody, references: [], scope: 'project',
        },
        {
          id: 'b:general', name: 'general', description: 'General coding rules',
          path: '/p', content: longBody, references: [], scope: 'bundled',
        },
      ])
      expect(block).toContain('- rules [project] — Project-specific rules')
      expect(block).toContain('- general — General coding rules')
    })

    it('sorts by priority: project > global > bundled', () => {
      const block = service.buildSkillsPromptBlock([
        { id: 'b:bundled', name: 'bundled-skill', description: 'B desc', path: '/p', content: 'B', references: [], scope: 'bundled' },
        { id: 'p:project', name: 'project-skill', description: 'P desc', path: '/p', content: 'P', references: [], scope: 'project' },
        { id: 'g:global', name: 'global-skill', description: 'G desc', path: '/p', content: 'G', references: [], scope: 'global' },
      ])

      const projectIdx = block.indexOf('project-skill')
      const globalIdx = block.indexOf('global-skill')
      const bundledIdx = block.indexOf('bundled-skill')

      expect(projectIdx).toBeLessThan(globalIdx)
      expect(globalIdx).toBeLessThan(bundledIdx)
    })
  })

  describe('parseSkillFrontmatter', () => {
    it('extracts name and description from YAML frontmatter', async () => {
      const { parseSkillFrontmatter } = await import('../skillService')
      const raw = `---
name: pdf-document
description: Generate PDFs via pandoc and weasyprint.
---

# PDF Document

Body here.`
      const parsed = parseSkillFrontmatter(raw, 'fallback')
      expect(parsed.name).toBe('pdf-document')
      expect(parsed.description).toBe('Generate PDFs via pandoc and weasyprint.')
      expect(parsed.body).toContain('# PDF Document')
      expect(parsed.body).not.toContain('---')
    })

    it('falls back to first paragraph after H1 when no frontmatter', async () => {
      const { parseSkillFrontmatter } = await import('../skillService')
      const raw = `# General Coding\n\nBest practices for clean code across projects.\n\n## Section\n\nMore.`
      const parsed = parseSkillFrontmatter(raw, 'general-coding')
      expect(parsed.name).toBe('general-coding')
      expect(parsed.description).toBe('Best practices for clean code across projects.')
    })

    it('caps overly long descriptions at the configured max', async () => {
      const { parseSkillFrontmatter } = await import('../skillService')
      const longDesc = 'a'.repeat(500)
      const raw = `---\nname: x\ndescription: ${longDesc}\n---\nbody`
      const parsed = parseSkillFrontmatter(raw, 'x')
      expect(parsed.description.length).toBeLessThanOrEqual(220)
      expect(parsed.description.endsWith('…')).toBe(true)
    })

    it('parses a YAML folded block scalar (description: >) instead of capturing just ">"', async () => {
      // Regression: the old single-regex parser captured only ">" for folded
      // scalars (its `\n*$` lookahead matched end-of-line right after the
      // indicator), so the model saw a 1-char description. See chakra-ui-*.
      const { parseSkillFrontmatter } = await import('../skillService')
      const raw = `---
name: chakra
description: >
  Build responsive, accessible UI components and layouts
  using Chakra UI v3 with tokens and recipes.
license: MIT
---

# Chakra`
      const parsed = parseSkillFrontmatter(raw, 'chakra')
      expect(parsed.name).toBe('chakra')
      expect(parsed.description).toBe(
        'Build responsive, accessible UI components and layouts using Chakra UI v3 with tokens and recipes.',
      )
    })

    it('parses a literal block scalar (description: |) and stops at the next key', async () => {
      const { parseSkillFrontmatter } = await import('../skillService')
      const raw = `---\nname: y\ndescription: |\n  Line one\n  Line two\ncacheable: true\n---\nbody`
      const parsed = parseSkillFrontmatter(raw, 'y')
      expect(parsed.description).toBe('Line one Line two')
      expect(parsed.cacheable).toBe(true)
    })

    it('strips surrounding quotes from an inline scalar', async () => {
      const { parseSkillFrontmatter } = await import('../skillService')
      const raw = `---\nname: z\ndescription: "Quoted description here."\n---\nbody`
      const parsed = parseSkillFrontmatter(raw, 'z')
      expect(parsed.description).toBe('Quoted description here.')
    })
  })

  describe('createProjectSkill', () => {
    it('creates directory and writes SKILL.md', async () => {
      const writtenPaths: string[] = []
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'create_directories_all') return undefined
        if (cmd === 'write_file') {
          writtenPaths.push((args as Record<string, unknown>).path as string)
          return undefined
        }
        throw new Error('Unexpected')
      })

      await service.createProjectSkill('/project', 'My Conventions', '# Rules')

      expect(writtenPaths).toHaveLength(1)
      // Canonical project-skill dir mirrors the global ~/.tmcode/skills.
      expect(writtenPaths[0]).toBe('/project/.tmcode/skills/my-conventions/SKILL.md')
    })

    it('sanitizes skill name', async () => {
      const createdDirs: string[] = []
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'create_directories_all') {
          createdDirs.push((args as Record<string, unknown>).path as string)
          return undefined
        }
        if (cmd === 'write_file') return undefined
        throw new Error('Unexpected')
      })

      await service.createProjectSkill('/project', 'My Weird!!  Name', '# Content')

      // Should sanitize to 'my-weird-name'
      expect(createdDirs.some(d => d.includes('my-weird-name'))).toBe(true)
    })
  })

  describe('deleteSkill', () => {
    it('throws on bundled skills', async () => {
      await expect(
        service.deleteSkill({
          id: 'bundled:react', name: 'react', description: 'React patterns', path: '/res/react',
          content: '', references: [], scope: 'bundled',
        })
      ).rejects.toThrow('Cannot delete bundled skills')
    })

    it('deletes project skills', async () => {
      let deletedPath = ''
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'delete_file_or_directory') {
          deletedPath = (args as Record<string, unknown>).path as string
          return undefined
        }
        throw new Error('Unexpected')
      })

      await service.deleteSkill({
        id: 'project:rules', name: 'rules', description: 'Project rules', path: '/project/.tmcode/skills/rules',
        content: '', references: [], scope: 'project',
      })

      expect(deletedPath).toBe('/project/.tmcode/skills/rules')
    })
  })
})
