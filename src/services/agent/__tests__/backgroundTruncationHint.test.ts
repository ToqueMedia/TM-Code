/**
 * A tool não pode convidar para um gesto que ela própria nega.
 *
 * Medido no export de 2026-08-02 (deploy do momenu-fact). Duas instruções
 * contraditórias chegaram ao modelo no mesmo turno:
 *
 *   output da tool:  "...(truncated — call check_background_commands with
 *                     id: X for the full output)"
 *   guardrail:       "END YOUR TURN NOW ... do not ask again"
 *
 * O modelo obedeceu ao convite três vezes seguidas (chamadas 54, 55, 56) e
 * levou com a recusa as três. Não foi teimosia: entre duas instruções que se
 * contradizem, seguiu a que prometia os dados. A escolha racional.
 *
 * O convite só faz sentido para comandos TERMINADOS — é aí que existe um
 * "output completo" para ir buscar, e é aí que o guardrail o permite. Enquanto
 * corre há apenas output parcial que vai crescer, e dizê-lo remove a
 * contradição sem esconder nada.
 *
 * Este teste lê a fonte: o formatador não é exportado, e o que interessa
 * proteger é a REGRA, não a assinatura da função.
 */
import * as fs from 'fs'
import * as path from 'path'

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'toolExecutor.ts'),
  'utf8',
)

/** O bloco que constrói a dica de truncagem. */
function truncationBlock(): string {
  const start = SOURCE.indexOf('const truncatedHint')
  expect(start).toBeGreaterThan(-1)
  return SOURCE.slice(start, start + 700)
}

describe('dica de truncagem dos comandos de fundo', () => {
  it('o convite a pedir por id é condicional ao estado do comando', () => {
    // A versão anterior era um ternário sobre `!opts?.full && length > MAX`,
    // sem olhar ao status — o convite saía com o comando a correr.
    expect(truncationBlock()).toMatch(/cmd\.status === 'running'/)
  })

  it('com o comando A CORRER não convida a pedir por id', () => {
    const block = truncationBlock()
    const runningBranch = block.slice(0, block.indexOf(':', block.indexOf('?')))
    expect(runningBranch).not.toMatch(/call \$\{CHECK_BACKGROUND_COMMANDS\}/)
    expect(runningBranch).toMatch(/parcial/)
  })

  it('com o comando TERMINADO mantém o convite — é o caminho documentado', () => {
    // Não se corrige uma contradição matando o gesto certo: pedir por id é
    // como se obtém o output completo de um comando que acabou.
    expect(truncationBlock()).toMatch(/call \$\{CHECK_BACKGROUND_COMMANDS\} with id/)
  })

  it('o guardrail continua a mandar terminar o turno e a nomear o auto-wake', () => {
    // O comportamento que o utilizador quer é PARAR e ser acordado — não uma
    // chamada bloqueante que segura o turno aberto.
    expect(SOURCE).toMatch(/END YOUR TURN NOW\. The system auto-wakes you/)
  })

  it('o guardrail NÃO nega o pedido por id de um comando já terminado', () => {
    // Regressão de 2026-07-29: negar isso bloqueava o gesto certo e o modelo
    // ouvia "não perguntes outra vez" ao ir buscar o que lhe tinham dito para
    // ir buscar.
    expect(SOURCE).toMatch(/backgroundPollRepeats >= 1 && \(!targetId \|\| targetStillRunning\)/)
  })
})
