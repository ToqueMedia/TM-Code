import { invoke } from '@tauri-apps/api/core'
import ContextBuilder from '../contextBuilder'

// invoke is already mocked in setupTests.ts
const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

describe('ContextBuilder', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    builder = ContextBuilder.getInstance()
    builder.invalidatePromptCache()
    mockedInvoke.mockReset()
    // ipcCache (`fileTreeStore` / `readFileStore`) and the fsVersion
    // counter are module-level state. Without resetting them, prior
    // tests' cached file-trees keep being served (so a test mocking
    // build_file_tree to throw never reaches the throwing mock), and
    // the monotonic fsVersion carries over (so tests asserting an
    // expected counter value see drift). The reset helpers exist for
    // exactly this scenario — wire them in here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { __resetIpcCacheForTests } = require('../ipcCache')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { __resetFsVersionForTests } = require('../../fsVersion')
    __resetIpcCacheForTests()
    __resetFsVersionForTests()
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
      // Reset scaffolding detector cache so tests don't pollute each other.
      // Without this, a previous test that triggered detection caches an
      // empty state, then a later test setting up VITE_GOOGLE_CLIENT_ID
      // sees the cached empty state and never re-scans.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { clearAllScaffoldingCache } = require('../../scaffoldingDetector')
      clearAllScaffoldingCache()

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
        if (cmd === 'path_exists') {
          // Default: no marker files exist (empty project)
          return false
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

    it('includes completion contract', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('Complete every file')
    })

    it('includes role section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Role')
    })

    it('includes environment section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Environment')
    })

    it('includes project structure section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Project structure')
    })

    it('includes constraints section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Constraints')
    })

    it('includes system section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# System')
    })

    it('includes reminder section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Reminder')
    })

    it('omits "Already-applied scaffolding" section when no scaffolding is detected', async () => {
      // Default mock has no .env keys, no marker files → detection returns
      // empty applied list → section short-circuits to null and is filtered
      // out of the joined prompt.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).not.toContain('# Already-applied scaffolding')
    })

    it('renders "Already-applied scaffolding" section with evidence when auth.google detected', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'build_file_tree') {
          return { name: 'project', is_directory: true, children: [] }
        }
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path?.endsWith('/.env')) {
            return 'VITE_GOOGLE_CLIENT_ID=clid.apps.googleusercontent.com\n'
          }
          throw new Error('File not found')
        }
        if (cmd === 'path_exists') {
          const path = (args as Record<string, unknown>)?.path as string
          // auth.google requires BOTH .env key AND a marker file (useGoogleSignIn)
          if (path?.includes('useGoogleSignIn')) return true
          return false
        }
        return null
      })
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Already-applied scaffolding')
      expect(prompt).toContain('auth.google')
      expect(prompt).toContain('.env:VITE_GOOGLE_CLIENT_ID')
      // Instruction lines must be present so the agent knows what to do.
      expect(prompt).toContain('DO NOT call `provision_auth` again')
      // Exception clause must allow explicit re-provisioning.
      expect(prompt).toContain('EXCEPTION')
      expect(prompt).toContain('rotate credentials')
      // Skill-read instruction must be present so the agent picks up
      // CRITICAL rules from the skill before patching from intuition
      // (the original scaffold may have ignored some rules).
      expect(prompt).toContain("read_skill('auth-proxy')")
      expect(prompt).toContain("read_skill('google-signin')")
    })

    it('omits skill-read hint when no auth/payments scaffolding is applied', async () => {
      // Default mock has no scaffolding markers — section is null entirely.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      // The exact phrase only appears inside getAppliedScaffoldingSection;
      // when that section is null, the phrase is absent.
      expect(prompt).not.toContain("read_skill('auth-proxy')")
      expect(prompt).not.toContain("read_skill('mom-factura-payments')")
    })

    it('lists payments.momenu skill-read hint when payments detected', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'build_file_tree') {
          return { name: 'project', is_directory: true, children: [] }
        }
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path?.endsWith('/package.json')) {
            return JSON.stringify({ dependencies: { 'mom-factura': '^1.0.0' } })
          }
          throw new Error('File not found')
        }
        if (cmd === 'path_exists') return false
        return null
      })
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('payments.momenu')
      expect(prompt).toContain("read_skill('mom-factura-payments')")
      // Auth-skill hint must NOT appear (no auth scaffolding detected)
      expect(prompt).not.toContain("read_skill('google-signin')")
    })

    it('lists multiple scaffoldings when several are detected simultaneously', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'build_file_tree') {
          return { name: 'project', is_directory: true, children: [] }
        }
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path?.endsWith('/.env')) {
            return 'VITE_FIREBASE_API_KEY=k\nVITE_GIP_TENANT_ID=t\nVITE_GOOGLE_CLIENT_ID=c\nMOM_FACTURA_API_KEY=m\n'
          }
          if (path?.endsWith('/package.json')) {
            return JSON.stringify({ dependencies: { 'mom-factura': '^1.0.0' } })
          }
          throw new Error('File not found')
        }
        if (cmd === 'path_exists') {
          // src/routes/auth-proxy.ts exists → satisfies email-password conjunction
          const path = (args as Record<string, unknown>)?.path as string
          return /auth-proxy\.ts$|useGoogleSignIn\.ts$/.test(path)
        }
        return null
      })
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Already-applied scaffolding')
      expect(prompt).toContain('auth.email-password')
      expect(prompt).toContain('auth.google')
      expect(prompt).toContain('payments.momenu')
    })

    it('includes anti-recap directive for post-compaction continuation', async () => {
      // Without this, after the auto-compaction boundary fires the model
      // tends to preface its next reply with "I'll continue", "Picking up
      // where we left off", or a recap of what was happening — wasted
      // tokens and adds friction. The directive in getSystemSection tells
      // the model to resume directly. Anchored to the literal text so a
      // future rewrite that drops the rule fails this test.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('AFTER COMPRESSION')
      expect(prompt).toContain('resume directly')
    })

    it('interpolates tool names from toolNames.ts (not hardcoded literals)', async () => {
      // Catch a regression where someone reverts a `${EXECUTE_COMMAND}`
      // back to the literal "execute_command" in a way that would
      // desynchronise from a future tool rename. We verify the
      // interpolation reached the rendered prompt — anchors are loose
      // (anywhere in the prompt) so a section reorganisation doesn't
      // false-positive this test.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toMatch(/execute_command/)
      expect(prompt).toMatch(/read_dev_server_logs/)
      expect(prompt).toMatch(/request_credentials/)
    })

    it('includes terminal-style loop guidance in Chat mode', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Terminal-style agent loop')
      expect(prompt).toContain('Operate like an interactive terminal operator')
      expect(prompt).toContain('execute_command_background')
      expect(prompt).toContain('check_background_commands')
    })

    it('includes terminal-style loop guidance in Terminal mode', async () => {
      const prompt = await builder.buildCmdModeSystemPrompt('/test/project', '/test/home')
      expect(prompt).toContain('**Mode: TERMINAL**')
      expect(prompt).toContain('# Terminal-style agent loop')
      expect(prompt).toContain('Operate like an interactive terminal operator')
      expect(prompt).toContain('execute_command_background')
      expect(prompt).toContain('check_background_commands')
    })

    it('includes package.json summary when available', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('react')
    })

    it('handles missing file tree gracefully', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'build_file_tree') {
          throw new Error('command not found')
        }
        throw new Error('File not found')
      })

      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('(Could not read project structure)')
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

    describe('fsVersion-aware cache', () => {
      // Pins the contract that a filesystem mutation (anywhere) invalidates
      // the cached system prompt. Without this, turn N+1 would see the file
      // tree as it was at the start of turn N — exactly the regression the
      // fsVersion counter was introduced to fix.

      it('cache hits when fsVersion is unchanged between builds', async () => {
        let buildCount = 0
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'build_file_tree') {
            buildCount++
            return { name: 'root', children: [] }
          }
          throw new Error('not found')
        })
        await builder.buildSystemPrompt('/p', 'web')
        await builder.buildSystemPrompt('/p', 'web')
        // Second call should hit cache → no new file-tree build.
        expect(buildCount).toBe(1)
      })

      it('cache misses after bumpFsVersion (write happened between builds)', async () => {
        let buildCount = 0
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'build_file_tree') {
            buildCount++
            return { name: 'root', children: [] }
          }
          throw new Error('not found')
        })
        await builder.buildSystemPrompt('/p', 'web')
        const { bumpFsVersion } = await import('../../fsVersion')
        bumpFsVersion('write:helper.ts')
        await builder.buildSystemPrompt('/p', 'web')
        // The bump must invalidate the cache → file tree re-read.
        expect(buildCount).toBe(2)
      })
    })
  })
})
