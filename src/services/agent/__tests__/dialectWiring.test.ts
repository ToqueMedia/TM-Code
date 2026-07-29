import { canonicalToolName } from '../toolNames'

/**
 * O executor tem de receber o nome que o MODELO escreveu.
 *
 * `toolExecutor.execute` começa por `const requestedToolName = toolName` e usa
 * esse valor para `normalizeToolInputForCanonical` e `routeTrainedToolCall` —
 * as duas funções que traduzem o dialecto de treino. Se o chamador já tiver
 * canonizado o nome, ambas caem no `default:` e não fazem nada, em silêncio.
 *
 * Foi exactamente o que aconteceu em 29-07: ao corrigir o portão de aprovação
 * de diffs (que precisa do nome CANÓNICO para o `WRITE_TOOLS.has`), canonizei
 * a mesma variável que segue para o executor. A normalização de input morreu
 * para o agente principal — e as 2015 asserções da suite passaram todas,
 * porque `trainedToolDialect.test.ts` exercita as funções ISOLADAS, que
 * continuavam corretas. O que ninguém verificava era a ligação.
 *
 * Consequências medidas na revisão: `Grep({pattern})` perdia o mapeamento para
 * `query` (erro de parâmetro em falta), `Grep` perdia o default de regex
 * (alternação `a|b` procurada literalmente, "No matches found" falso), `Bash`
 * com `run_in_background` deixava de ser reencaminhado e bloqueava o turno, e
 * `Glob({path})` varria a raiz do projecto em vez da subpasta pedida.
 *
 * A asserção é ESTRUTURAL, sobre o texto da fonte, e digo-o à cabeça: o
 * caminho é dentro de uma closure de uma classe grande, sem ponto de injecção
 * para espiar o argumento. Isto não prova o comportamento — prova que a
 * variável canónica e a variável crua continuam separadas, que é a única
 * coisa que impede a regressão de voltar.
 */
describe('ligação do dialecto de treino ao executor', () => {
  // `require` e não `import`: o setup do Jest mocka o módulo `fs`, e este
  // teste precisa do real para ler a própria fonte.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = jest.requireActual('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realPath = jest.requireActual('path') as typeof import('path')
  const source: string = realFs.readFileSync(
    realPath.resolve(__dirname, '../agentService.ts'),
    'utf8',
  )

  it('as duas variáveis existem e são distintas', () => {
    expect(source).toContain('const canonicalName = canonicalToolName(toolName)')
    expect(source).toContain('let effectiveToolName = toolName;')
    // O que NÃO pode voltar: a variável que segue para o executor a nascer
    // canonizada.
    expect(source).not.toContain('let effectiveToolName = canonicalToolName(')
  })

  it('o executor é chamado com o nome CRU', () => {
    const call = source.slice(
      source.indexOf('this.toolExecutor.execute('),
      source.indexOf('this.toolExecutor.execute(') + 200,
    )
    expect(call).toContain('effectiveToolName')
    expect(call).not.toContain('canonicalName')
  })

  it('as comparações locais usam o nome CANÓNICO', () => {
    // Um `WRITE_TOOLS.has` com o nome cru devolve false para `Edit`/`Write` e
    // salta o portão de aprovação de diffs por inteiro.
    expect(source).toContain('WRITE_TOOLS.has(canonicalName)')
    expect(source).not.toContain('WRITE_TOOLS.has(effectiveToolName)')
    expect(source).toContain('canonicalName === "execute_command"')
  })

  it('os nomes de treino que a ligação serve traduzem de facto', () => {
    // Se algum destes deixar de mapear, o guarda acima passa a proteger nada.
    expect(canonicalToolName('Grep')).toBe('search_files')
    expect(canonicalToolName('Glob')).toBe('glob')
    expect(canonicalToolName('Bash')).toBe('execute_command')
    expect(canonicalToolName('Edit')).toBe('edit_file')
    expect(canonicalToolName('Write')).toBe('write_file')
  })
})
