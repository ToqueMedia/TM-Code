/**
 * Contradição por OMISSÃO no system prompt.
 *
 * A varredura de contradições de 2026-07-30 procurava linhas ERRADAS: nomes de
 * tools fora do dialecto de treino, instruções sobre comportamento inexistente,
 * `${VAR}` por interpolar. Apanhou o que procurava e deixou passar isto:
 *
 *   chatSections.ts   → "Never poll; end your turn and wait for auto-wake"  (3x)
 *   sharedSections.ts → "observe it later with check_background_commands"   (sem a regra)
 *
 * Nenhuma linha está errada. A segunda está INCOMPLETA, e um agente que só veja
 * essa secção nunca soube que sondar em ciclo é proibido. Custou 8 sondagens em
 * 59 calls no export de 2026-08-02 (deploy do momenu-fact) — 5 delas puro
 * desperdício.
 *
 * A lição de método: uma varredura linha-a-linha não encontra uma regra em
 * FALTA. Só encontrar quem compara o que secções diferentes dizem sobre a mesma
 * tool. É isso que este teste faz.
 */
import * as fs from 'fs'
import * as path from 'path'

const SECTIONS_DIR = path.join(__dirname, '..', 'contextBuilder', 'sections')

function sectionFiles(): Array<{ name: string; source: string }> {
  return fs.readdirSync(SECTIONS_DIR)
    .filter(f => f.endsWith('.ts') && !f.includes('.test.'))
    .map(name => ({ name, source: fs.readFileSync(path.join(SECTIONS_DIR, name), 'utf8') }))
}

/**
 * Regras que NÃO podem viajar sozinhas: se uma secção menciona a tool, tem de
 * carregar a restrição. Acrescentar aqui é o que impede que a próxima secção
 * nasça incompleta.
 */
const RULES: Array<{
  tool: RegExp
  /** Como a restrição se reconhece no texto. */
  rule: RegExp
  why: string
}> = [
  {
    tool: /CHECK_BACKGROUND_COMMANDS/,
    rule: /never poll|do not (call it repeatedly|ask again)|END YOUR TURN/i,
    why: 'sondar em ciclo custou 8 calls em 59 (export 2026-08-02); a regra tem de vir com a tool',
  },
]

describe('contradição por omissão entre secções do prompt', () => {
  it('há secções para varrer — o teste não pode passar por vácuo', () => {
    // Sem esta guarda, um caminho errado fazia o `it.each` abaixo varrer uma
    // lista VAZIA e passar a verde — a pior espécie de teste. Foi o que
    // aconteceu à primeira: pus o limiar em >2 sem olhar, e só há 2 secções.
    const files = sectionFiles()
    expect(files.length).toBeGreaterThanOrEqual(2)
    // E as DUAS que falam da tool têm de ser encontradas — é o par que
    // divergiu (chatSections tinha a regra, sharedSections não).
    const mentioning = files.filter(f => RULES[0].tool.test(f.source)).map(f => f.name)
    expect(mentioning.sort()).toEqual(['chatSections.ts', 'sharedSections.ts'])
  })

  it.each(RULES)('$why', ({ tool, rule }) => {
    const offenders = sectionFiles()
      .filter(({ source }) => tool.test(source))
      .filter(({ source }) => !rule.test(source))
      .map(({ name }) => name)

    expect(offenders).toEqual([])
  })

  it('detecta a omissão quando ela existe (o guarda morde)', () => {
    // Sem isto eu não saberia se o teste passa por mérito ou por a regex da
    // regra ser larga de mais. Simula a secção como estava antes da correcção.
    const antes = 'Use `${EXECUTE_COMMAND_BACKGROUND}` for long work; '
      + 'observe it later with `${CHECK_BACKGROUND_COMMANDS}` before relying on the result.'
    expect(RULES[0].tool.test(antes)).toBe(true)
    expect(RULES[0].rule.test(antes)).toBe(false)
  })
})
