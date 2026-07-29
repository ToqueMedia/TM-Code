import { useAgentStore } from '../agentStore'

/**
 * A janela de contexto do modelo não pode ser perdida por acidente.
 *
 * Sintoma reportado (screenshot katondo, 29-07): a pill mostrava
 * "Janela bruta 200.0k · Pressão 251.7% (overrun) · Compaction is overdue"
 * para um modelo cuja janela real é 1M. 200K é o FALLBACK_CONTEXT_WINDOW —
 * ou seja, a pill tinha perdido o valor vindo do header
 * `X-Model-Context-Window` e caído no fallback, enquanto o motor de
 * auto-compact usava a janela real e por isso, correctamente, NÃO compactava.
 * O alarme era a pill a julgar com o número errado.
 *
 * Duas fugas, testadas aqui e no getter do snapshot:
 *  1. `resetTransientState` (troca de projecto) anulava a identidade do
 *     modelo. Mas o modelo gerido é GLOBAL, não por projecto, e estes campos
 *     só se repovoam com a próxima resposta do worker — que pode nunca vir
 *     (créditos esgotados, por exemplo).
 *  2. O getter do snapshot devolvia null quando o estado vivo estava vazio, e
 *     como o persist reescreve o ficheiro inteiro, isso APAGAVA a última
 *     janela conhecida em vez de a deixar quieta.
 */
describe('identidade do modelo sobrevive à troca de projecto', () => {
  beforeEach(() => {
    useAgentStore.setState({
      modelName: 'glm-5.2',
      modelContextWindow: 1_000_000,
      modelMaxOutputTokens: 128_000,
      byokActive: true,
      teamByokActive: true,
      status: 'generating',
      error: 'boom',
    })
  })

  it('resetTransientState preserva a janela, o nome e o teto de output', () => {
    useAgentStore.getState().resetTransientState()
    const s = useAgentStore.getState()

    expect(s.modelContextWindow).toBe(1_000_000)
    expect(s.modelName).toBe('glm-5.2')
    expect(s.modelMaxOutputTokens).toBe(128_000)
  })

  it('resetTransientState continua a limpar o que É transiente', () => {
    useAgentStore.getState().resetTransientState()
    const s = useAgentStore.getState()

    expect(s.status).toBe('idle')
    expect(s.error).toBeNull()
    // BYOK é decisão por sessão, não identidade global do modelo gerido.
    expect(s.byokActive).toBe(false)
    expect(s.teamByokActive).toBe(false)
  })

  it('um modelo diferente a responder continua a substituir a identidade', () => {
    // O update é opt-in (só mexe no que o caller passa) — é o único momento em
    // que a identidade muda de facto.
    useAgentStore.getState().setModelInfo('outro-modelo', null, undefined, 200_000)
    const s = useAgentStore.getState()

    expect(s.modelName).toBe('outro-modelo')
    expect(s.modelContextWindow).toBe(200_000)
  })
})
