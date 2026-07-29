/**
 * Dialecto de treino do modelo (auditoria 2026-07-28).
 *
 * MEDIÇÃO que motivou isto: numa sessão real, 14 de 16 tool calls usaram os
 * nomes do Claude Code (`Grep`, `Read`, `LS`) em vez dos canónicos — com ZERO
 * erros, porque esses quatro já tinham alias. O modelo não deixa de emitir o
 * dialecto de treino por lhe darmos outro schema; o que muda é só se existe
 * tradução. Os nomes SEM alias caíam em `Unknown tool: Bash` — um turno
 * perdido no tool mais usado do claude-vaz.
 *
 * Regra que estes testes fixam: traduz-se o que tem contrato compatível;
 * o que diverge dá um erro que NOMEIA o substituto e a forma.
 */
import { matchesAnyGlob } from '../toolExecutor/searchFormatters'
import {
  canonicalToolName,
  routeTrainedToolCall,
  normalizeToolInputForCanonical,
  DIVERGENT_TRAINED_TOOLS,
  READ_FILE, SEARCH_FILES, GLOB, LIST_DIRECTORY,
  EXECUTE_COMMAND, EXECUTE_COMMAND_BACKGROUND, EDIT_FILE, WRITE_FILE, DELEGATE, WEB_FETCH, WEB_SEARCH,
} from '../toolNames'

describe('nomes de treino → canónicos', () => {
  it.each([
    ['Read', READ_FILE], ['Grep', SEARCH_FILES], ['Glob', GLOB], ['LS', LIST_DIRECTORY],
    ['Bash', EXECUTE_COMMAND], ['Edit', EDIT_FILE], ['Write', WRITE_FILE],
    ['Task', DELEGATE], ['WebFetch', WEB_FETCH], ['WebSearch', WEB_SEARCH],
  ])('%s → %s', (alias, canonical) => {
    expect(canonicalToolName(alias)).toBe(canonical)
  })

  it('nomes desconhecidos passam intactos (não inventa traduções)', () => {
    expect(canonicalToolName('mcp__foo__bar')).toBe('mcp__foo__bar')
    expect(canonicalToolName('edit_file')).toBe('edit_file')
  })
})

describe('normalização de argumentos', () => {
  it('Bash: timeout em MILISSEGUNDOS vira timeout_secs', () => {
    // A armadilha: copiar o número cru dava 120000 SEGUNDOS de teto.
    const out = normalizeToolInputForCanonical('Bash', { command: 'ls', timeout: 120_000 })
    expect(out.timeout_secs).toBe(120)
    expect(out.command).toBe('ls')
  })

  it('Bash: timeout_secs explícito ganha ao timeout', () => {
    const out = normalizeToolInputForCanonical('Bash', { command: 'ls', timeout: 5000, timeout_secs: 42 })
    expect(out.timeout_secs).toBe(42)
  })

  it('Bash sem timeout não inventa nenhum', () => {
    expect(normalizeToolInputForCanonical('Bash', { command: 'ls' }).timeout_secs).toBeUndefined()
  })

  it('Edit/Write passam intactos — são idênticos campo a campo', () => {
    const edit = { file_path: '/a.ts', old_string: 'x', new_string: 'y', replace_all: true }
    expect(normalizeToolInputForCanonical('Edit', edit)).toEqual(edit)
    const write = { file_path: '/a.ts', content: 'body' }
    expect(normalizeToolInputForCanonical('Write', write)).toEqual(write)
  })

  it('Task: subagent_type chega ao delegate', () => {
    const out = normalizeToolInputForCanonical('Task', {
      subagent_type: 'Explore', description: 'find X', prompt: 'where is X defined',
    })
    expect(out.subagent_type).toBe('Explore')
    expect(out.prompt).toBe('where is X defined')
  })
})

describe('contratos divergentes — erro que ensina, não beco sem saída', () => {
  it.each(Object.keys(DIVERGENT_TRAINED_TOOLS))('%s tem substituto nomeado', (name) => {
    const guidance = DIVERGENT_TRAINED_TOOLS[name]
    expect(guidance.length).toBeGreaterThan(20)
  })

  it('TodoWrite explica a FORMA, não só o nome', () => {
    // Nomear o tool sem a forma dos args deixa o modelo a adivinhar o schema.
    expect(DIVERGENT_TRAINED_TOOLS.TodoWrite).toContain('tasks')
    expect(DIVERGENT_TRAINED_TOOLS.TodoWrite).toContain('update_tasks')
  })

  it('MultiEdit aponta o replace_all como caminho equivalente', () => {
    expect(DIVERGENT_TRAINED_TOOLS.MultiEdit).toContain('replace_all')
  })

  it('divergentes NÃO são traduzidos por canonicalToolName', () => {
    // Traduzir um contrato incompatível seria pior do que o erro: produzia uma
    // chamada silenciosamente errada.
    for (const name of Object.keys(DIVERGENT_TRAINED_TOOLS)) {
      expect(canonicalToolName(name)).toBe(name)
    }
  })
})

describe('adoptar o NOME adopta as EXPECTATIVAS do nome', () => {
  it('Bash com run_in_background vai para a tool de background', () => {
    // A renomeação CRIOU este risco: antes `Bash` dava "Unknown tool" (falha
    // honesta); depois, o parâmetro do contrato de treino era engolido e o
    // comando corria a bloquear enquanto o modelo fechava o turno à espera de
    // um auto-wake que nunca chegava.
    expect(routeTrainedToolCall('Bash', EXECUTE_COMMAND, { command: 'npm i', run_in_background: true }))
      .toBe(EXECUTE_COMMAND_BACKGROUND)
  })

  it('Bash normal continua a bloquear', () => {
    expect(routeTrainedToolCall('Bash', EXECUTE_COMMAND, { command: 'ls' })).toBe(EXECUTE_COMMAND)
    expect(routeTrainedToolCall('Bash', EXECUTE_COMMAND, { command: 'ls', run_in_background: false }))
      .toBe(EXECUTE_COMMAND)
  })

  it('o encaminhamento não afecta quem não pediu Bash', () => {
    expect(routeTrainedToolCall('execute_command', EXECUTE_COMMAND, { run_in_background: true }))
      .toBe(EXECUTE_COMMAND)
  })

  it('Grep: -A/-B/-C viram contextLines (o maior pedido)', () => {
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x', '-C': 3 }).contextLines).toBe(3)
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x', '-A': 2, '-B': 5 }).contextLines).toBe(5)
  })

  it('Grep: contextLines explícito ganha às flags', () => {
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x', '-C': 9, contextLines: 1 }).contextLines).toBe(1)
  })

  it('Grep sem flags de contexto não inventa nenhum', () => {
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x' }).contextLines).toBeUndefined()
  })
})

describe('type do Grep e ignore do LS — filtros que o modelo julgava ter', () => {
  it('type: "ts" vira os globs da família', () => {
    // Sem tradução, o modelo pedia `type` e recebia a árvore INTEIRA — o
    // filtro existia na cabeça dele e não no pedido.
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x', type: 'ts' }).includePatterns)
      .toEqual(['*.ts', '*.tsx'])
  })

  it('glob explícito ganha ao type', () => {
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x', type: 'ts', glob: '*.spec.ts' }).includePatterns)
      .toEqual(['*.spec.ts'])
  })

  it('type desconhecido não inventa filtro (devolver a mais > engolir em silêncio)', () => {
    expect(normalizeToolInputForCanonical('Grep', { pattern: 'x', type: 'cobol' }).includePatterns)
      .toBeUndefined()
  })

  it('matchesAnyGlob: dialecto do ignore do LS', () => {
    expect(matchesAnyGlob('a.test.ts', ['*.test.ts'])).toBe(true)
    expect(matchesAnyGlob('node_modules', ['node_modules'])).toBe(true)
    expect(matchesAnyGlob('index.ts', ['*.test.ts'])).toBe(false)
  })

  it('matchesAnyGlob escapa metacaracteres — "a.b" não casa "axb"', () => {
    // Sem escape, o `.` do glob virava "qualquer carácter" e o ignore comia
    // ficheiros que o utilizador não pediu para excluir.
    expect(matchesAnyGlob('axb', ['a.b'])).toBe(false)
    expect(matchesAnyGlob('a.b', ['a.b'])).toBe(true)
  })

  it('matchesAnyGlob: lista vazia nunca exclui', () => {
    expect(matchesAnyGlob('qualquer', [])).toBe(false)
  })
})
