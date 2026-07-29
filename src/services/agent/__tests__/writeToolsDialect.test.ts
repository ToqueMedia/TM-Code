import { canonicalToolName } from '../toolNames'

/**
 * O portão de aprovação de diffs vive atrás de um `WRITE_TOOLS.has(name)` em
 * agentService, e `WRITE_TOOLS` guarda os nomes CANÓNICOS.
 *
 * Quando as tools foram renomeadas para o dialecto de treino, o modelo passou
 * a chamar `Edit`/`Write` — e este call site comparava o nome cru. `Edit` não
 * está em `WRITE_TOOLS`, portanto o portão inteiro era saltado: o agente
 * publicava o diff, NÃO esperava por decisão nenhuma, e seguia para a tool
 * seguinte com o utilizador ainda a olhar para os botões Accept/Reject.
 *
 * Medido na sessão momenu-fact de 29-07: três `Edit` seguidos de `Grep`,
 * `Read` e `Bash` — treze turnos, um por tool call, nenhum bloqueado.
 *
 * Efeito colateral do mesmo salto: o modelo recebia o JSON CRU do diff (o
 * ficheiro velho e o novo por inteiro) em vez do resumo compacto pós-edição.
 *
 * Este teste fixa a premissa que torna o `canonicalToolName` obrigatório
 * nesse call site: os nomes de treino NÃO são os canónicos.
 */
describe('dialecto de treino vs conjuntos de nomes canónicos', () => {
  // A cópia do conjunto que agentService usa para decidir se um resultado
  // precisa de aprovação de diff.
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file'])

  it('os nomes de treino não pertencem ao conjunto canónico — normalizar não é opcional', () => {
    expect(WRITE_TOOLS.has('Edit')).toBe(false)
    expect(WRITE_TOOLS.has('Write')).toBe(false)
  })

  it('canonicalToolName traz os nomes de treino de volta ao conjunto', () => {
    expect(WRITE_TOOLS.has(canonicalToolName('Edit'))).toBe(true)
    expect(WRITE_TOOLS.has(canonicalToolName('Write'))).toBe(true)
  })

  it('os nomes canónicos atravessam a normalização inalterados', () => {
    for (const name of ['edit_file', 'write_file', 'create_file']) {
      expect(canonicalToolName(name)).toBe(name)
      expect(WRITE_TOOLS.has(canonicalToolName(name))).toBe(true)
    }
  })

  it('o Bash do dialecto de treino resolve para execute_command', () => {
    // O mesmo call site redirecciona leituras-por-shell (`cat`, `head`) para
    // o Read; com o nome cru, essa redirecção nunca disparava.
    expect(canonicalToolName('Bash')).toBe('execute_command')
    expect(canonicalToolName('execute_command')).toBe('execute_command')
  })
})
