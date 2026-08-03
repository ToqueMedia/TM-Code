/**
 * O índice de ficheiros (@-menção e Cmd+P) delega o caminhar ao Rust
 * (`build_file_tree` com `respectGitignore`), que usa o crate `ignore` — o
 * mesmo do ripgrep, e portanto a mesma estratégia do claude-vaz.
 *
 * O que se protege aqui é a razão de ter mudado. A versão anterior percorria o
 * disco em TS e decidia com uma lista estática + um parse do `.gitignore` da
 * RAIZ que só honrava nomes de directório de segmento único. No momenu-fact o
 * `functions/.gitignore` tem `lib/**` + `lib/**\/*.js` — aninhado E glob — e os
 * ficheiros transpilados apareciam na menção `@`, exactamente o que o
 * claude-vaz não faz no mesmo projecto.
 */
const invokeMock = jest.fn()
jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}))

import QuickOpenService from '../quickOpenService'

type Node = { name: string; isDirectory?: boolean; children?: Node[] }

/** Árvore como o Rust a devolveria: já SEM o que o gitignore apanha. */
const TREE: Node = {
  name: 'proj', isDirectory: true, children: [
    { name: 'src', isDirectory: true, children: [
      { name: 'ApiClient.ts' },
    ] },
    { name: 'functions', isDirectory: true, children: [
      { name: 'src', isDirectory: true, children: [{ name: 'index.ts' }] },
      // `functions/lib/` NÃO vem: o Rust aplicou o .gitignore aninhado.
    ] },
  ],
}

describe('índice de ficheiros — gitignore', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'build_file_tree') return TREE
      if (cmd === 'path_exists') return false
      return null
    })
  })

  it('pede a árvore ao Rust com respectGitignore ligado', async () => {
    const svc = QuickOpenService.getInstance()
    await svc.reset()
    await svc.initialize('/Users/dev/proj')
    const call = invokeMock.mock.calls.find(c => c[0] === 'build_file_tree')
    expect(call).toBeDefined()
    expect(call?.[1]).toMatchObject({ rootPath: '/Users/dev/proj', filter: { respectGitignore: true } })
  })

  it('não indexa transpilados que o gitignore aninhado apanha', async () => {
    const svc = QuickOpenService.getInstance()
    await svc.reset()
    await svc.initialize('/Users/dev/proj')
    const paths = svc.search('index').map(r => r.path)
    expect(svc.search('lib').some(r => r.path.includes('/functions/lib/'))).toBe(false)
    expect(paths.some(p => p.endsWith('/functions/src/index.ts'))).toBe(true)
  })

  it('o `.env` continua indexado apesar de gitignored — excepção deliberada', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'build_file_tree') return TREE
      if (cmd === 'path_exists') return String(args?.path).endsWith('/.env')
      return null
    })
    const svc = QuickOpenService.getInstance()
    await svc.reset()
    await svc.initialize('/Users/dev/proj')
    const paths = svc.search('env').map(r => r.path)
    expect(paths.some(p => p.endsWith('/.env'))).toBe(true)
  })
})
