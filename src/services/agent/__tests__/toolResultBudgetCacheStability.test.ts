/**
 * Estabilidade de bytes do orçamento de tool results (2026-07-31).
 *
 * Este é o equivalente portável ao "microcompact com edição de cache" do
 * claude-vaz. Ele tem uma API para apagar de dentro do prefixo cacheado; nós
 * não temos — o que temos é a possibilidade de DEIXAR DE LHE MEXER.
 *
 * O que estava mal, medido com uma sonda de 40 turnos antes da correção:
 *   · 28 turnos em 40 reescreviam blocos já enviados (476 blocos ao todo).
 *     Todos os providers fazem cache por PREFIXO: a primeira mudança de bytes
 *     invalida tudo o que vem depois, portanto reescrever o bloco mais antigo
 *     era garantir 0% de cache num histórico longo;
 *   · o resultado mais antigo acumulava SETE camadas de `[tool-result-summary]`,
 *     porque cada passagem embrulhava o sumário anterior — o preview mostrava o
 *     cabeçalho da camada anterior e o conteúdo original tinha desaparecido;
 *   · e o total CRESCIA em vez de encolher: cada volta acrescentava bytes.
 *
 * Depois: 6 turnos em 40, 32 blocos, 1 camada.
 */
import { applyGlobalToolResultBudget } from '../toolResultGlobalBudget'

type Msg = { role: 'user' | 'assistant'; content: any }

function turn(i: number, repeats = 300): Msg[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool_call',
        id: `t${i}`,
        name: 'read_file',
        arguments: JSON.stringify({ file_path: `/p/f${i}.ts` }),
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: `t${i}`,
        content: `LINHA-${i} de conteudo do ficheiro. `.repeat(repeats),
      }],
    },
  ]
}

const resultContents = (m: Msg[]): string[] =>
  m.filter(x => x.role === 'user').map(x => x.content[0].content as string)

const layersIn = (s: string) => (s.match(/\[tool-result-summary\]/g) || []).length

/** Corre N turnos realimentando o resultado, como o loop faz via state.messages. */
function simulate(turns: number, budgetTokens = 40_000) {
  let msgs: Msg[] = []
  let prev: string[] = []
  let rewrittenBlocks = 0
  let turnsWithRewrite = 0
  let peakTokens = 0

  for (let i = 0; i < turns; i++) {
    msgs = [...msgs, ...turn(i)]
    const r = applyGlobalToolResultBudget(msgs, { budgetTokens, keepRecent: 4 })
    msgs = r.messages as Msg[]
    peakTokens = Math.max(peakTokens, r.tokensAfter)

    const cur = resultContents(msgs)
    const changed = prev.filter((p, idx) => cur[idx] !== undefined && cur[idx] !== p).length
    if (changed > 0) {
      rewrittenBlocks += changed
      turnsWithRewrite++
    }
    prev = cur
  }

  return {
    msgs,
    rewrittenBlocks,
    turnsWithRewrite,
    peakTokens,
    maxLayers: Math.max(...resultContents(msgs).map(layersIn)),
  }
}

describe('orçamento global de tool results — estabilidade de prefixo', () => {
  it('nunca embrulha um sumário noutro sumário', () => {
    const { maxLayers } = simulate(40)
    // Sete camadas não era só feio: o preview passava a mostrar o cabeçalho da
    // camada anterior, e a dica "relê via read_file" apontava para conteúdo que
    // já não existia por baixo de nenhuma delas.
    expect(maxLayers).toBe(1)
  })

  it('reescreve o prefixo em poucos turnos, não em todos', () => {
    const { turnsWithRewrite, rewrittenBlocks } = simulate(40)
    // A histerese é o que compra isto: evictar até 70% do teto em vez de até um
    // fio abaixo dele. Os números exactos dependem da carga; o que a asserção
    // fixa é a ORDEM DE GRANDEZA que separa "cache viva" de "cache morta".
    expect(turnsWithRewrite).toBeLessThan(12)
    expect(rewrittenBlocks).toBeLessThan(60)
  })

  it('converge: o total fica sob o teto em vez de crescer a cada passagem', () => {
    const { peakTokens } = simulate(40)
    expect(peakTokens).toBeLessThanOrEqual(40_000)
  })

  it('um resultado já compactado é devolvido byte-a-byte igual', () => {
    let msgs: Msg[] = []
    for (let i = 0; i < 14; i++) {
      msgs = [...msgs, ...turn(i)]
      msgs = applyGlobalToolResultBudget(msgs, { budgetTokens: 40_000, keepRecent: 4 })
        .messages as Msg[]
    }
    const compacted = resultContents(msgs).find(c => layersIn(c) === 1)
    expect(compacted).toBeDefined()

    // Reaplicar o orçamento ao MESMO array não pode mexer em nada — é o que
    // acontece quando um turno não acrescenta nada de novo.
    const again = applyGlobalToolResultBudget(msgs, { budgetTokens: 40_000, keepRecent: 4 })
    expect(resultContents(again.messages as Msg[])).toEqual(resultContents(msgs))
  })

  it('continua a compactar o que é preciso — a estabilidade não virou inação', () => {
    const { msgs } = simulate(20)
    const compactedCount = resultContents(msgs).filter(c => layersIn(c) === 1).length
    expect(compactedCount).toBeGreaterThan(0)
    // Os mais recentes ficam INTACTOS: é o working set do turno em curso.
    const all = resultContents(msgs)
    expect(layersIn(all[all.length - 1])).toBe(0)
  })
})
