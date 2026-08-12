/**
 * Contabilidade de leituras dos evals.
 *
 * O caso que motivou o módulo está no fim: uma corrida que lê oito ficheiros
 * por `tail` e era reportada como "0 releituras de 0 ficheiros" — o melhor
 * resultado possível, produzido por cegueira. Um instrumento que confunde
 * "não releu" com "não vi" é pior do que não ter instrumento.
 */
import {
  computeReadAccounting,
  extractShellReadTargets,
  type MessageLike,
} from '../readAccounting'

const call = (toolName: string, input: unknown) => ({ toolName, input })

describe('extractShellReadTargets', () => {
  it.each([
    ['tail -50 src/auth.js', ['src/auth.js']],
    ['cat package.json', ['package.json']],
    ['head -n 20 /abs/path/billing.js', ['/abs/path/billing.js']],
    ['sed -n "990,1000p" src/report.js', ['src/report.js']],
  ])('apanha leitura simples: %s', (cmd, esperado) => {
    expect(extractShellReadTargets(cmd)).toEqual(esperado)
  })

  it('apanha os dois lados de um pipe e de um &&', () => {
    expect(extractShellReadTargets('cat a.js | grep FOO b.js')).toEqual(['a.js', 'b.js'])
    expect(extractShellReadTargets('tail -5 x.ts && head -5 y.ts')).toEqual(['x.ts', 'y.ts'])
  })

  // O falso positivo mais provável: o PADRÃO do grep parecer um ficheiro.
  it('não conta o padrão de pesquisa como ficheiro', () => {
    expect(extractShellReadTargets('grep -n REFERENCIA_AUTH src/auth.js')).toEqual(['src/auth.js'])
  })

  it('não conta pastas nem flags', () => {
    expect(extractShellReadTargets('grep -rn foo src/')).toEqual([])
    expect(extractShellReadTargets('tail -f -n 100 app.log')).toEqual(['app.log'])
  })

  it.each([
    'npm test',
    'git commit -m "fix: a.js"',
    'node scripts/build.mjs',
    'rm -f TOTAL.txt',
    '',
  ])('comando que não lê devolve vazio: %s', (cmd) => {
    expect(extractShellReadTargets(cmd)).toEqual([])
  })
})

describe('computeReadAccounting', () => {
  it('conta releituras por read_file, como antes', () => {
    const msgs: MessageLike[] = [
      { toolCalls: [call('read_file', { file_path: '/p/a.js' })] },
      { toolCalls: [call('read_file', { file_path: '/p/b.js' })] },
      { toolCalls: [call('read_file', { file_path: '/p/a.js' })] },
    ]
    const r = computeReadAccounting(msgs)
    expect(r.distinctFilesRead).toBe(2)
    expect(r.rereads).toBe(1)
    expect(r.shellReads).toBe(0)
  })

  // O BURACO que este módulo veio fechar.
  it('conta leituras feitas por shell — antes eram invisíveis', () => {
    const msgs: MessageLike[] = [
      { toolCalls: [call('execute_command', { command: 'tail -20 src/auth.js' })] },
      { toolCalls: [call('execute_command', { command: 'tail -20 src/audit.js' })] },
    ]
    const r = computeReadAccounting(msgs)
    expect(r.distinctFilesRead).toBe(2)
    expect(r.shellReads).toBe(2)
  })

  // A via mista: ler com a tool e voltar com a shell É uma releitura.
  it('atravessa vias diferentes do MESMO ficheiro', () => {
    const msgs: MessageLike[] = [
      { toolCalls: [call('read_file', { file_path: '/projecto/src/billing.js' })] },
      { toolCalls: [call('execute_command', { command: 'tail -5 src/billing.js' })] },
    ]
    const r = computeReadAccounting(msgs)
    expect(r.distinctFilesRead).toBe(1)
    expect(r.rereads).toBe(1)
  })

  it('expõe a mistura de ferramentas', () => {
    const msgs: MessageLike[] = [
      { toolCalls: [call('read_file', { file_path: '/p/a.js' }), call('execute_command', { command: 'ls' })] },
      { toolCalls: [call('execute_command', { command: 'tail -5 b.js' })] },
    ]
    expect(computeReadAccounting(msgs).toolsUsed).toEqual({
      read_file: 1,
      execute_command: 2,
    })
  })

  it('tolera mensagens sem tool calls e input em falta', () => {
    const msgs: MessageLike[] = [{}, { toolCalls: [] }, { toolCalls: [call('read_file', undefined)] }]
    const r = computeReadAccounting(msgs)
    expect(r).toMatchObject({ rereads: 0, distinctFilesRead: 0, shellReads: 0 })
  })

  // A REGRESSÃO concreta observada a 2026-08-07: oito ficheiros lidos por
  // `tail`, reportados como "0 releituras de 0 ficheiros" — indistinguível de
  // uma corrida perfeita.
  it('a corrida que era reportada como perfeita deixa de o ser', () => {
    const ficheiros = ['auth', 'audit', 'billing', 'inventory', 'mailer', 'report', 'search', 'shipping']
    const msgs: MessageLike[] = [
      { toolCalls: ficheiros.map(f => call('read_file', { file_path: `/p/src/${f}.js` })) },
      { toolCalls: ficheiros.map(f => call('execute_command', { command: `tail -3 src/${f}.js` })) },
    ]
    const r = computeReadAccounting(msgs)
    expect(r.distinctFilesRead).toBe(8)
    expect(r.rereads).toBe(8)   // antes: 0
    expect(r.shellReads).toBe(8)
  })
})
