import { invoke } from '@tauri-apps/api/core'
import { readGeneratedPaths } from '../projectUtils'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

/**
 * Regressão momenu-fact (2026-07-28): o agente leu `functions/lib/*.js`
 * (output de `tsc`) como se fosse fonte e propôs apagá-lo. Um dev humano não
 * precisa de deduzir isto — sabe que os `.js` ao lado de `src/` são gerados.
 * O modelo não tinha o dado, e o NOME da pasta não o dá: `functions/lib` era
 * output e `lib/` noutro projecto é fonte legítima. Quem o declara é o
 * `outDir` do próprio tsconfig.
 */
describe('readGeneratedPaths', () => {
  const PROJECT = '/proj'

  function mockFs(
    files: Record<string, string>,
    dirs: string[],
    opts: { dirsByPath?: Record<string, string[]>; exists?: string[]; ignored?: string[] } = {},
  ): void {
    mockedInvoke.mockReset()
    // `safeReadFile` passa pelo ipcCache, que é estado de módulo: sem reset, o
    // tsconfig lido no teste anterior continua a ser servido e o mock novo
    // nunca é alcançado.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { __resetIpcCacheForTests } = require('../../ipcCache')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { __resetFsVersionForTests } = require('../../../fsVersion')
    __resetIpcCacheForTests()
    __resetFsVersionForTests()
    mockedInvoke.mockImplementation(((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'list_directory') {
        const path = String(args?.path ?? '')
        const names = path === PROJECT ? dirs : (opts.dirsByPath?.[path] ?? [])
        return Promise.resolve(names.map(name => ({ name, is_directory: true })))
      }
      if (cmd === 'read_file_content' || cmd === 'read_file') {
        const path = String(args?.path ?? args?.filePath ?? '')
        const hit = files[path]
        return hit === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(hit)
      }
      if (cmd === 'path_exists') {
        return Promise.resolve((opts.exists ?? []).includes(String(args?.path ?? '')))
      }
      if (cmd === 'is_path_gitignored') {
        return Promise.resolve((opts.ignored ?? []).includes(String(args?.filePath ?? '')))
      }
      return Promise.resolve(null)
    }) as unknown as typeof invoke)
  }

  it('finds outDir declared in a NESTED tsconfig, not just the root', async () => {
    // A forma exacta do momenu-fact: a raiz não declara outDir nenhum; é o
    // functions/tsconfig.json que diz `outDir: "lib"`. Ler só a raiz não via
    // nada — e era precisamente `functions/lib` que o agente quis apagar.
    mockFs(
      {
        [`${PROJECT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { strict: true } }),
        [`${PROJECT}/functions/tsconfig.json`]: JSON.stringify({
          compilerOptions: { outDir: 'lib' },
        }),
      },
      ['functions', 'src'],
    )

    const generated = await readGeneratedPaths(PROJECT)
    expect(generated.map(g => g.path)).toContain('functions/lib')
    expect(generated.find(g => g.path === 'functions/lib')?.source).toBe(
      'functions/tsconfig.json outDir',
    )
  })

  it('stays silent about lib/ when no tsconfig declares it as output', async () => {
    // O caso oposto, e a razão para não haver lista de nomes: há projectos que
    // guardam fonte real em lib/. Marcá-la como gerada seria pior do que
    // não dizer nada — o agente recusaria editar a fonte.
    mockFs(
      { [`${PROJECT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { strict: true } }) },
      ['lib', 'src'],
    )

    expect(await readGeneratedPaths(PROJECT)).toEqual([])
  })

  it('reads outDir through tsconfig JSONC comments and trailing commas', async () => {
    mockFs(
      {
        [`${PROJECT}/tsconfig.json`]: `{
          // comentário de linha
          "compilerOptions": {
            /* bloco */
            "outDir": "./dist",
          },
        }`,
      },
      [],
    )

    const generated = await readGeneratedPaths(PROJECT)
    expect(generated.map(g => g.path)).toEqual(['dist'])
  })

  it('follows declared workspaces to reach a package two levels down', async () => {
    // Um monorepo põe os tsconfigs em `packages/<nome>/` — profundidade 2. A
    // varredura de um nível não lá chegava; os workspaces declarados dizem
    // exactamente onde procurar.
    mockFs(
      {
        [`${PROJECT}/package.json`]: JSON.stringify({ workspaces: ['packages/*'] }),
        [`${PROJECT}/packages/api/tsconfig.json`]: JSON.stringify({
          compilerOptions: { outDir: 'build' },
        }),
      },
      ['packages'],
      { dirsByPath: { [`${PROJECT}/packages`]: ['api', 'web'] } },
    )

    const generated = await readGeneratedPaths(PROJECT)
    expect(generated.map(g => g.path)).toContain('packages/api/build')
  })

  it('reports Cargo target/, which the toolchain fixes rather than the project', async () => {
    mockFs({ [`${PROJECT}/src-tauri/Cargo.toml`]: '[package]\nname = "x"\n' }, ['src-tauri'])

    const generated = await readGeneratedPaths(PROJECT)
    expect(generated.map(g => g.path)).toContain('src-tauri/target')
  })

  describe('bundler defaults', () => {
    // Só entram com TRÊS sinais independentes: dependência declarada, o
    // directório existe, e o projecto ignora-o no git. Qualquer um em falta e
    // ficamos calados — marcar fonte real como gerada faria o modelo recusar-se
    // a editar código verdadeiro, que é pior do que não dizer nada.
    const pkg = JSON.stringify({ devDependencies: { vite: '^5' } })

    it('accepts dist/ when dependency, existence and gitignore all agree', async () => {
      mockFs({ [`${PROJECT}/package.json`]: pkg }, [], {
        exists: [`${PROJECT}/dist`],
        ignored: [`${PROJECT}/dist`],
      })

      const generated = await readGeneratedPaths(PROJECT)
      expect(generated.map(g => g.path)).toEqual(['dist'])
    })

    it('stays silent when dist/ is tracked — that is source, not output', async () => {
      mockFs({ [`${PROJECT}/package.json`]: pkg }, [], { exists: [`${PROJECT}/dist`] })

      expect(await readGeneratedPaths(PROJECT)).toEqual([])
    })

    it('stays silent when dist/ does not exist — outDir was overridden elsewhere', async () => {
      mockFs({ [`${PROJECT}/package.json`]: pkg }, [], { ignored: [`${PROJECT}/dist`] })

      expect(await readGeneratedPaths(PROJECT)).toEqual([])
    })

    it('stays silent when no bundler is a declared dependency', async () => {
      mockFs({ [`${PROJECT}/package.json`]: JSON.stringify({ dependencies: {} }) }, [], {
        exists: [`${PROJECT}/dist`],
        ignored: [`${PROJECT}/dist`],
      })

      expect(await readGeneratedPaths(PROJECT)).toEqual([])
    })
  })

  it('ignores an outDir that escapes the project root', async () => {
    mockFs(
      {
        [`${PROJECT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { outDir: '../shared' } }),
      },
      [],
    )

    expect(await readGeneratedPaths(PROJECT)).toEqual([])
  })
})
