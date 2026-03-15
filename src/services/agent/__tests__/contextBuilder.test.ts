import { invoke } from '@tauri-apps/api/core'
import ContextBuilder from '../contextBuilder'

// invoke is already mocked in setupTests.ts
const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

describe('ContextBuilder', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    builder = ContextBuilder.getInstance()
    mockedInvoke.mockReset()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = ContextBuilder.getInstance()
      const b = ContextBuilder.getInstance()
      expect(a).toBe(b)
    })
  })

  describe('buildSystemPrompt', () => {
    beforeEach(() => {
      // Default mock: file tree returns a simple tree, other reads return null
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'build_file_tree') {
          return {
            name: 'project',
            is_directory: true,
            children: [
              { name: 'src', is_directory: true, children: [] },
              { name: 'package.json', is_directory: false },
            ],
          }
        }
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path?.endsWith('package.json')) {
            return JSON.stringify({
              name: 'test-project',
              scripts: { dev: 'vite', build: 'tsc' },
              dependencies: { react: '^19.0.0' },
              devDependencies: { typescript: '~5.8' },
            })
          }
          if (path?.endsWith('README.md')) {
            return '# Test Project\nA simple project for testing.'
          }
          // Lock files — return null to simulate not found
          throw new Error('File not found')
        }
        return null
      })
    })

    it('returns a string', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(typeof prompt).toBe('string')
    })

    it('includes the project path', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('/test/project')
    })

    it('includes the project type', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('web')
    })

    it('includes completion rule section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<completion_rule>')
    })

    it('includes role section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<role>')
    })

    it('includes environment section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<environment>')
    })

    it('includes project structure section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<project_structure>')
    })

    it('includes constraints section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<constraints>')
    })

    it('includes examples section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<examples>')
    })

    it('includes task rules section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<task_rules>')
    })

    it('includes reminder section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<reminder>')
    })

    it('includes package.json summary when available', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('test-project')
      expect(prompt).toContain('react')
    })

    it('includes README summary when available', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('<readme_summary>')
      expect(prompt).toContain('Test Project')
    })

    it('handles missing file tree gracefully', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'build_file_tree') {
          throw new Error('command not found')
        }
        throw new Error('File not found')
      })

      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('Could not read project structure')
    })

    it('handles missing package.json gracefully', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'build_file_tree') {
          return { name: 'root', children: [] }
        }
        throw new Error('File not found')
      })

      // Should not throw
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(typeof prompt).toBe('string')
    })
  })
})
