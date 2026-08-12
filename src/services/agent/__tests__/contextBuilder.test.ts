import { invoke } from '@tauri-apps/api/core'
import ContextBuilder from '../contextBuilder'
import { BOUNDED_INLINE_CONTEXTS } from '../contextBuilder/auxiliaryRegistry'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../contextBuilder/helpers'
import { getCriticalReinjectionReminder } from '../contextBuilder/sections/chatSections'
import { WRITE_ALIAS, EDIT_ALIAS, CREATE_FILE } from '../toolNames'

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

    // A decisão hasImage → perfil 'vision' foi INLINADA no contextBuilder
    // (2026-07-30) quando `profileForSignals` — que ignorava a mensagem e os
    // ficheiros mencionados para devolver um enum a partir de um booleano —
    // foi apagada. O teste que a cobria morreu com ela; este trava o mesmo
    // comportamento no sítio onde ele passou a viver, que é o que interessa:
    // com imagem, as regras de visão entram no prompt.
    it('uma imagem faz o perfil ser vision e carrega vision.image_rules', async () => {
      await builder.buildSystemPrompt(
        '/test/project', 'web', undefined, undefined, 'olha este screenshot',
        undefined, undefined, { hasImage: true },
      )
      const sel = builder.getLastAuxiliarySelection()
      expect(sel?.profile).toBe('vision')
      expect(sel?.loaded.map(l => l.id)).toContain('vision.image_rules')
    })

    it('sem imagem fica em default_task e as regras de visão não entram', async () => {
      await builder.buildSystemPrompt(
        '/test/project', 'web', undefined, undefined, 'corrige este bug',
      )
      const sel = builder.getLastAuxiliarySelection()
      expect(sel?.profile).toBe('default_task')
      // Forma `string | null` do cli-vaz: a secção só entra quando tem
      // referente. Sem imagem na sessão, o texto sobre imagens não vai.
      expect(sel?.loaded.map(l => l.id)).not.toContain('vision.image_rules')
      expect(sel?.omitted.map(o => o.id)).toContain('vision.image_rules')
    })

    // A linha de base de UI vive numa linha SÓ, no lembrete final, sem versão
    // longa nenhuma — a forma do cli-vaz depois de 2026-08-06. Este teste trava
    // a promessa: é a única coisa que carrega a regra dos estados vazios.
    it('a linha de base de UI chega ao prompt: curta na recência E longa inline', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
      expect(prompt).toContain('state-first')
      expect(prompt).toContain('Empty states GUIDE')
      // …e a LONGA também, sem portão nenhum: medido em 8 falhas em 10 quando
      // se tentou viver só com a curta (ver a nota em sharedSections.ts).
      expect(prompt).toContain('# UI baseline (when generating frontend')
      // `# Taste defaults` foi apagada: 414 tokens de restrição sem nenhum
      // observável que os justifique (duas experiências, 16 corridas verdes
      // sem ela). A restrição continua na linha curta do lembrete.
      expect(prompt).not.toContain('# Taste defaults (frontend/UI work)')
    })

    // Forma `string | null`: a secção do GoLive não pode custar tokens a quem
    // não usa GoLive, e tem de aparecer a quem usa.
    it('a verificação do GoLive só entra quando o projecto tem golive.json', async () => {
      const semGoLive = await fullPrompt('/test/project', 'web')
      expect(semGoLive).not.toContain('projecto GoLive')

      builder.invalidatePromptCache()
      const base = mockedInvoke.getMockImplementation()!
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path?.endsWith('golive.json')) return '{"project":"x"}'
        }
        return base(cmd, args as never)
      })
      const comGoLive = await fullPrompt('/test/golive', 'web')
      expect(comGoLive).toContain('projecto GoLive')
      expect(comGoLive).toContain('valida o que o bundler faz')
      // Um comando que sai sozinho — sem ciclo de vida de dev server, e
      // portanto sem conflito com a regra geral de o manter vivo.
      expect(comGoLive).toContain('golive dev --check')
      // O fallback foi medido a ser tomado SEM tentativa (2026-08-07): o
      // agente foi direto ao `npm run build`. Tem de estar condicionado ao
      // erro concreto, não oferecido como alternativa.
      expect(comGoLive).toContain('unknown option --check')
      expect(comGoLive).not.toContain('DESLIGA')
    })

    it('returns a string', async () => {
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(typeof prompt).toBe('string')
    })

    // ── Anúncio das tools diferidas (2026-08-12) ────────────────────────
    //
    // A regressão que estes testes travam não tem sintoma: marcar uma tool
    // como diferida tira-lhe o schema, e se o nome não for ANUNCIADO o modelo
    // deixa de saber que ela existe. Não há erro — ele apenas nunca a pede.
    // A primeira tentativa passou 5/5 nas evals exactamente assim.
    describe('deferred tool announcement', () => {
      it('os nomes diferidos entram no prompt ESTÁTICO', async () => {
        const prompt = await builder.buildSystemPrompt(
          '/test/project', 'web', undefined, undefined, undefined, undefined, undefined,
          { deferredToolNames: ['WebFetch', 'lsp'] },
        )
        expect(prompt).toContain('# Deferred tools')
        expect(prompt).toContain('WebFetch')
        expect(prompt).toContain('lsp')
        // Estático, não volátil: o conjunto é fixo durante o run, portanto
        // pertence ao prefixo cacheável. Se cair abaixo da fronteira, paga-se
        // em cada turno o que se estava a tentar poupar.
        //
        // `buildSystemPrompt` já devolve SÓ a metade estática (o volátil sai
        // por getLastVolatileContext, e o marcador da fronteira nem chega ao
        // texto) — logo o `toContain` acima é a prova de que é estático, e
        // esta é a prova de que não está TAMBÉM no volátil, duplicado.
        expect(builder.getLastVolatileContext() ?? '').not.toContain('# Deferred tools')
      })

      it('sem nomes diferidos a secção não aparece', async () => {
        const prompt = await builder.buildSystemPrompt('/test/project', 'web')
        expect(prompt).not.toContain('# Deferred tools')
      })

      // O PASSO DE RISCO da funcionalidade. O prompt muda, a chave não, e o
      // build seguinte serve o prompt anterior — o modelo lê nomes de tools
      // que já não estão no schema (ou deixa de ler os que estão) e nada
      // falha visivelmente.
      it('mudar o conjunto diferido invalida a cache do prompt', async () => {
        const primeiro = await builder.buildSystemPrompt(
          '/test/project', 'web', undefined, undefined, undefined, undefined, undefined,
          { deferredToolNames: ['WebFetch'] },
        )
        const segundo = await builder.buildSystemPrompt(
          '/test/project', 'web', undefined, undefined, undefined, undefined, undefined,
          { deferredToolNames: ['WebFetch', 'generate_image'] },
        )
        expect(primeiro).not.toContain('generate_image')
        expect(segundo).toContain('generate_image')
      })
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
          profile: 'default_task',
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
      expect(selection?.profile).toBe('default_task')
      // 'deterministic', não 'fallback' (2026-08-03): não há planner para
      // falhar — a selecção determinística é o desenho, e a telemetria não
      // pode auto-descrever o desenho como degradação.
      expect(selection?.contextPlannerStatus).toBe('deterministic')
      // Determinística NÃO quer dizer VAZIA (auditoria 2026-07-28) e, desde a
      // doutrina full-delivery (2026-08-03), também não quer dizer mínima: as
      // secções BOUNDED vão todas inline (BOUNDED_INLINE_CONTEXTS) + a
      // baseline de delivery; on-demand ficam só as unbounded — MENOS as que
      // o portão de evidência do projecto reteve (achado #9, 2026-08-05).
      // O fixture declara `react` mas não tem tema, nem Chakra, nem imagem.
      expect([...(selection?.contextPlan.selectedContexts ?? [])].sort()).toEqual(
        [...BOUNDED_INLINE_CONTEXTS, 'delivery.git_status', 'delivery.dev_server'].sort(),
      )
      expect(prompt).not.toContain('__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
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

    it('descreve o batching de writes como ele é — sem "run serially"', async () => {
      // O nome antigo deste teste ("allows multiple serial diff-producing
      // tools") e a frase que ele travava vinham de quando os writes CORRIAM
      // mesmo em série. Depois do lote de diffs (2026-07-31) o runtime despacha
      // writes a ficheiros distintos em paralelo — e a frase "write tools run
      // serially" ficou a contradizer, duas secções acima, a promessa de lote
      // que o próprio prompt passou a fazer. Contradição no prompt custa mais
      // do que instrução em falta: o modelo escolhe uma das duas ao acaso.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain(
        `each \`${WRITE_ALIAS}\`/\`${EDIT_ALIAS}\`/\`${CREATE_FILE}\` call produces its own diff`,
      )
      expect(prompt).toContain('You MAY make multiple file-change tool calls in the same assistant response')
      // A regra do mesmo ficheiro tem de estar dita: é o hazard de lost update.
      expect(prompt).toContain('two writes to the SAME file are chained')
      expect(prompt).not.toContain('write tools run serially')
      expect(prompt).not.toMatch(new RegExp(['Claude', 'Code parity'].join('\\s+')))
    })

    it('declares parallel tool-call capability in the tools section', async () => {
      // Auditoria momenu-fact (2026-07-31): sem a declaração explícita de
      // capacidade, o modelo emitia 1 call/turno em 8/8 turnos apesar da
      // instrução de batching enterrada em subsecção.
      const prompt = await builder.buildSystemPrompt('/test/project', 'web')
      expect(prompt).toContain('You can call MULTIPLE tools in a single response')
      expect(prompt).toContain('ONE batch of diffs')
    })

    it('o Reminder acaba no bullet 13 e o MCP é o 14', async () => {
      // O bullet sobre calls (13) saiu em 2026-07-31 junto com a secção
      // `# Turn efficiency`: o claude-vaz não tem nenhum dos dois, e a
      // doutrina explícita mediu-se a levar 8 → 31 calls na MESMA tarefa
      // (mandava maximizar uma contagem). O encaminhamento para o sub-agente
      // vive agora na descrição do Grep/Glob/LS — o sítio onde o modelo está
      // quando ia disparar o 3.º grep.
      // O 12 passou a ser "as TUAS sessões por defeito" (2026-08-06): pedir
      // "analisa a sessão anterior" mandava o agente ao histórico do Claude
      // Code, porque era a única coisa que o prompt dizia sobre sessões.
      const plain = await fullPrompt('/test/project', 'web')
      expect(plain).toContain('12. **SESSÕES ANTERIORES — as TUAS por defeito.**')
      expect(plain).toContain('13. **OUTRO agente, quando nomeado**')
      const tail = plain.slice(plain.indexOf('12. **SESSÕES ANTERIORES')).split('\n#')[0]
      expect(tail).not.toContain('\n14.')

      const withMcp = await fullPrompt('/test/project', 'web', [
        { name: 'query_db', description: 'run a query', serverName: 'postgres' },
      ])
      expect(withMcp).toContain('14. **MCP available**')
      expect(withMcp).not.toContain('15. **MCP available**')
    })

    it('a secção # Turn efficiency já não é injetada', async () => {
      const prompt = await fullPrompt('/test/project', 'web')
      expect(prompt).not.toContain('# Turn efficiency')
      expect(prompt).not.toContain('## Batch within a turn')
      expect(prompt).not.toContain('## Skip expensive verification')
      // As DUAS regras que não eram sobre eficiência mudaram de casa e têm de
      // continuar vivas: a de correctness em `# Doing tasks`…
      expect(prompt).toContain('Removing a symbol means removing EVERY reference')
      // …e a declaração de multi-tool, que fica na secção de tools.
      expect(prompt).toContain('You can call MULTIPLE tools in a single response')
    })

    it('critical reinjection reminder restates the batching rule', () => {
      // O comentário de getCriticalReinjectionReminder exige acordo entre o
      // Reminder estático e a re-injeção — o bullet 13 tem de ter eco aqui.
      const reminder = getCriticalReinjectionReminder()
      expect(reminder).toContain('Batch independent tool calls in one assistant message.')
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
          profile: 'default_task',
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
          profile: 'default_task' as const,
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
