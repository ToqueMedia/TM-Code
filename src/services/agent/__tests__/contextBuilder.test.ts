import { invoke } from '@tauri-apps/api/core'
import ContextBuilder from '../contextBuilder'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../contextBuilder/helpers'

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

// invoke is already mocked in setupTests.ts
const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

function completionEnvelope(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
  })
}

function mockResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => undefined,
    },
    text: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

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
    Reflect.deleteProperty(globalThis, 'fetch')
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
        if (cmd === 'path_exists') {
          // Default: no marker files exist (empty project)
          return false
        }
        return null
      })
    })

    // FASE B (2026-07-17): o prompt devolvido é o bloco ESTÁTICO; as secções
    // voláteis (environment/árvore/git/…) seguem em getLastVolatileContext()
    // e são anexadas à mensagem do user pelos runners. Os testes de presença
    // verificam o CONJUNTO (estático + volátil) — o modelo recebe ambos.
    const fullPrompt = async (...args: Parameters<typeof builder.buildSystemPrompt>) => {
      const staticPart = await builder.buildSystemPrompt(...args)
      return `${staticPart}\n\n${builder.getLastVolatileContext() ?? ''}`
    }

    it('returns a string', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(typeof prompt).toBe('string')
    })

    it('includes the project path (static + volatile)', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
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

    it('includes environment section (volatile block)', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
      expect(prompt).toContain('# Environment')
    })

    it('includes project structure section (volatile block)', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
      expect(prompt).toContain('# Project structure')
    })

    it('includes constraints section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Constraints')
    })

    it('does not inject missing-TMS creation guidance into the normal task prompt', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')

      expect(prompt).not.toContain('No TMS.md yet')
      expect(prompt).not.toContain('After completing your first significant task')
      expect(prompt).not.toContain('This project has no TMS.md')
    })

    it('builds without calling the model context planner (FASE C: planner disabled)', async () => {
      const fetchMock = jest.fn()
        .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      Object.defineProperty(globalThis, 'fetch', {
        value: fetchMock,
        configurable: true,
        writable: true,
      })

      const prompt = await builder.buildSystemPrompt(
        '/test/project',
        'web',
        [],
        20,
        'Rota: /billing ou /payments. Detectar NIF e abrir modal.',
        [],
        {
          profile: 'frontend_ui',
          readOnly: false,
          source: 'model',
          confidence: 'high',
          reason: 'frontend UI task',
        },
      )
      const selection = builder.getLastAuxiliarySelection()

      expect(prompt).toContain('# Role')
      // Planner desligado: ZERO chamadas sidecar; seleção determinística.
      expect(fetchMock).toHaveBeenCalledTimes(0)
      expect(selection?.profile).toBe('frontend_ui')
      expect(selection?.contextPlannerStatus).toBe('fallback')
      expect(selection?.contextPlan.selectedContexts).toEqual([])
    })

    it('includes system section', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# System')
    })

    it('includes reminder section', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
      expect(prompt).toContain('# Reminder')
    })

    it('omits the scaffolding/hashtag sections for a plain message on a plain project', async () => {
      // MANAGED-PLATFORM cut (2026-07): filesystem-marker scaffolding
      // detection was removed with the managed layer. The prompt must not
      // resurrect the applied-scaffolding framing, and without a hashtag in
      // the user message the hashtag-intent section stays out too.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).not.toContain('# Already-applied scaffolding')
      expect(prompt).not.toContain('# Hashtag-signalled intent')
      expect(prompt).not.toContain("read_skill('auth-proxy')")
      expect(prompt).not.toContain("read_skill('mom-factura-payments')")
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

    it('allows multiple serial diff-producing tools in one response', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('each `write_file`/`edit_file`/`create_file` call produces a reviewable diff')
      expect(prompt).toContain('You MAY make multiple file-change tool calls in the same assistant response')
      expect(prompt).not.toMatch(new RegExp(['Claude', 'Code parity'].join('\\s+')))
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
      expect(prompt).toMatch(/stop_dev_server/)
      expect(prompt).toMatch(/request_credentials/)
    })

    it('keeps Chat-mode preview handoff manual after dev server verification', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('The Preview view does NOT open automatically')
      expect(prompt).toContain('click the **Preview** button at the top-right of Chat')
    })

    it('includes shell execution loop guidance', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('# Shell execution loop')
      expect(prompt).toContain('Operate like an interactive shell operator')
      expect(prompt).toContain('execute_command_background')
      expect(prompt).toContain('check_background_commands')
    })

    it('keeps selected auxiliary content below the dynamic boundary', async () => {
      const plannerJson = JSON.stringify({
        taskDomain: 'test/auxiliary-boundary',
        requiredCapabilities: ['scaffold_workflow', 'vision', 'dev_server', 'semantic_tokens'],
        minimumContextNeeded: 'summary',
        candidateContexts: [
          'scaffold.workflow',
          'vision.image_rules',
          'delivery.dev_server',
          'design_system.semantic_tokens',
        ],
        selectedContexts: [
          'scaffold.workflow',
          'vision.image_rules',
          'delivery.dev_server',
          'design_system.semantic_tokens',
        ],
        toolGroups: ['FILE_OPS', 'SHELL'],
        fallbackRisk: 'medium',
        reason: 'exercise dynamic-boundary placement',
      })
      const fetchMock = jest.fn().mockResolvedValue(mockResponse(completionEnvelope(plannerJson)) as never)
      Object.defineProperty(globalThis, 'fetch', {
        value: fetchMock,
        configurable: true,
        writable: true,
      })

      const prompt = await builder.buildSystemPrompt(
        '/test/project',
        'web',
        [],
        20,
        'Create a new React app with auth from a screenshot',
        [],
        {
          profile: 'scaffold_project',
          readOnly: false,
          source: 'model',
          confidence: 'high',
          reason: 'boundary regression test',
        },
      )

      // FASE B: o boundary deixou de existir DENTRO do prompt — virou o
      // ponto de CORTE. Invariantes novos: estático sem secções voláteis,
      // volátil com elas, e o marcador literal nunca chega ao modelo.
      const volatile = builder.getLastVolatileContext() ?? ''
      expect(prompt).toContain('# Role')
      expect(prompt).not.toContain('# Environment')
      expect(volatile).toContain('# Environment')
      expect(prompt).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
      expect(volatile).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    })

    it('includes package.json summary when available', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
      expect(prompt).toContain('react')
    })

    it('handles missing file tree gracefully', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'build_file_tree') {
          throw new Error('command not found')
        }
        throw new Error('File not found')
      })

      const prompt = await fullPrompt('/test/project', 'web')
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

    describe('dynamic prompt cache', () => {
      // The cache key includes a signature of dynamic prompt content. Even if
      // fsVersion does not move, a newly observed tree/memory/tracker snapshot
      // must not reuse a stale full prompt.

      it('does not serve stale session memory when dynamic content changes without fsVersion', async () => {
        const { useChatStore } = await import('../../../stores/chatStore')
        useChatStore.getState().createSession('/p')
        const intentOverride = {
          profile: 'bugfix_local' as const,
          readOnly: false,
          reason: 'test',
          source: 'keyword' as const,
          confidence: 'high' as const,
        }

        useChatStore.getState().setSessionMemory('first session note')
        await builder.buildSystemPrompt('/p', 'web', [], 20, 'fix it', [], intentOverride)
        const firstVol = builder.getLastVolatileContext() ?? ''
        useChatStore.getState().setSessionMemory('second session note')
        await builder.buildSystemPrompt('/p', 'web', [], 20, 'fix it', [], intentOverride)
        const secondVol = builder.getLastVolatileContext() ?? ''

        // FASE B: a memória de sessão vive no bloco VOLÁTIL — e a assinatura
        // dinâmica da cacheKey continua a impedir servir volátil stale.
        expect(firstVol).toContain('first session note')
        expect(secondVol).toContain('second session note')
        expect(secondVol).not.toContain('first session note')
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
