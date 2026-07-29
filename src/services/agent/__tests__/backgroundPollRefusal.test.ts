/**
 * A recusa de polling do `check_background_commands`.
 *
 * A regra "não faças polling" existia em três sítios do prompt e na descrição
 * da tool — e mesmo assim a sessão katondo-streaming (29-07) fez 15 chamadas
 * seguidas a ver se o `npm install` já tinha acabado: 42% dos turnos, ~552 mil
 * tokens de input, para um auto-wake que depois funcionou em 86 segundos.
 *
 * A causa não era falta de instrução: era o circuito de retorno. Cada resposta
 * a um comando ainda a correr parecia informação útil, portanto o modelo
 * repetia. Prosa não compete com o que a tool devolve.
 *
 * Estes testes fixam a decisão pura — quando repetir é inútil — para não
 * depender de montar o executor inteiro.
 */

/** Espelha a decisão em toolExecutor: assinatura dos comandos ainda a correr. */
function makeGate() {
  let lastSignature = ''
  let repeats = 0
  return function check(running: string[]): 'output' | 'refusal' {
    const signature = [...running].sort().join(',')
    if (signature && signature === lastSignature) repeats += 1
    else {
      repeats = 0
      lastSignature = signature
    }
    return repeats >= 1 ? 'refusal' : 'output'
  }
}

describe('recusa de polling do check_background_commands', () => {
  it('a primeira consulta responde com output', () => {
    const gate = makeGate()
    expect(gate(['cmd-1'])).toBe('output')
  })

  it('a segunda consulta seguida, sem nada mudar, é recusada', () => {
    const gate = makeGate()
    gate(['cmd-1'])
    expect(gate(['cmd-1'])).toBe('refusal')
    expect(gate(['cmd-1'])).toBe('refusal')
  })

  it('quando o comando termina, a resposta normal volta', () => {
    const gate = makeGate()
    gate(['cmd-1'])
    expect(gate(['cmd-1'])).toBe('refusal')
    // O install acabou: já não há nada a correr — é a consulta que interessa,
    // e é precisamente a que NÃO pode ser recusada.
    expect(gate([])).toBe('output')
  })

  it('um comando NOVO a correr reinicia a contagem', () => {
    const gate = makeGate()
    gate(['cmd-1'])
    expect(gate(['cmd-1'])).toBe('refusal')
    // Segundo install disparado: estado diferente, pergunta legítima.
    expect(gate(['cmd-1', 'cmd-2'])).toBe('output')
    expect(gate(['cmd-1', 'cmd-2'])).toBe('refusal')
  })

  it('a ordem dos ids não conta como mudança de estado', () => {
    const gate = makeGate()
    gate(['cmd-1', 'cmd-2'])
    expect(gate(['cmd-2', 'cmd-1'])).toBe('refusal')
  })

  it('sem nada a correr nunca há recusa — não é um bloqueio, é anti-desperdício', () => {
    const gate = makeGate()
    expect(gate([])).toBe('output')
    expect(gate([])).toBe('output')
  })
})
