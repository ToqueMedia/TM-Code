/**
 * Compactação NÃO destrutiva — e a história de COMO deixou de precisar deste
 * remendo.
 *
 * 2026-07-28: a compactação substituía o histórico inteiro por uma mensagem de
 * sumário, incluindo os tool results sobre os quais o modelo estava a meio de
 * agir. A correção da altura foi preservar 3 turnos VERBATIM.
 *
 * 2026-07-31: `buildPostCompactRecoveryBlock` foi reposto (era código morto) e
 * ligado aos dois caminhos de compactação. Ele re-injeta o que o sumário não
 * devolve — conteúdo dos ficheiros lidos, plano, skills — que é o mecanismo do
 * claude-vaz (`createPostCompactFileAttachments`). O estado de trabalho passou
 * a estar protegido pela peça certa.
 *
 * 2026-08-06: os 3 turnos saíram. Eram o remendo de um problema que a
 * recuperação já resolvia, e o preço estava medido numa sessão real (janela
 * 131K): compactou aos 98%, aterrou aos 88%, e voltou ao limiar em seis
 * pedidos. O número de TURNOS é um mau procurador do TAMANHO — um único turno
 * com uma leitura de 40K estraga a compactação na mesma, por isso nenhum valor
 * >0 servia. O cli-vaz sumariza tudo no caminho normal (`messagesToKeep` só
 * existe no parcial, `partialCompactConversation`); agora aqui também.
 *
 * O que estes testes travam hoje: `splitForCompaction` continua a cortar em
 * fronteiras de assistant e a preservar N quando N é pedido explicitamente (o
 * `/compact` manual usa-o), e o default é 0.
 */
import {
  compactNow,
  splitForCompaction,
  KEEP_RECENT_TURNS_ON_COMPACT,
} from '../compact/autoCompact'

import type { ContentBlockAPI } from '../../../types/chat'

/** Mesma forma do MessageLike interno do autoCompact. */
type Msg = { role: 'user' | 'assistant'; content: string | ContentBlockAPI[] | null }

/** N turnos completos: user → assistant → (tool results como user). */
function conversation(turns: number): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `pergunta ${i}` })
    out.push({ role: 'assistant', content: `resposta ${i}` })
    // Forma REAL de um tool result: role 'user' com blocos `tool_result`. A
    // fixture usava uma string, e isso escondia a diferença entre "o developer
    // falou" e "chegou um resultado de tool" — que é exactamente a distinção
    // de que a compactação depende para não engolir a instrução actual.
    out.push({
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: `t${i}`, content: `tool result ${i}` }],
    })
  }
  return out
}

describe('splitForCompaction', () => {
  it('corta numa fronteira de assistant (nunca deixa um tool result órfão)', () => {
    const { older, recent } = splitForCompaction(conversation(6), 2)
    expect(recent[0].role).toBe('assistant')
    expect(older[older.length - 1].role).not.toBe('assistant')
  })

  it('preserva exatamente os N turnos mais recentes', () => {
    const asText = (m: Msg): string =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map(b => (b.type === 'tool_result' ? b.content : '')).join('')
    const { recent } = splitForCompaction(conversation(6), 2)
    expect(recent.map(asText)).toEqual([
      'resposta 4', 'tool result 4',
      'pergunta 5', 'resposta 5', 'tool result 5',
    ])
  })

  it('não preserva nada quando não há turnos que cheguem (compactar tem de libertar espaço)', () => {
    const msgs = conversation(2)
    const { older, recent } = splitForCompaction(msgs, 3)
    expect(recent).toEqual([])
    expect(older).toEqual(msgs)
  })

  // A INSTRUÇÃO ACTUAL sobrevive sempre, mesmo com 0. Sumarizá-la foi medido
  // a 2026-08-06: a compactação disparou entre o prompt e a resposta, engoliu
  // "implementar `golive dev --check`", e o agente foi ler documentação e
  // falar de outra flag. Nem no modo de emergência isso se justifica — a
  // instrução são centenas de tokens e não é ela que estoura o pedido.
  it('com 0, a instrução actual sobrevive e o resto vai para o sumário', () => {
    const msgs = conversation(6)
    const { older, recent } = splitForCompaction(msgs, 0)
    // A instrução E tudo o que veio depois dela (a resposta em curso e os
    // tool results dessa volta) — cortar a meio deixaria um tool_result órfão.
    expect(recent[0].content).toBe('pergunta 5')
    expect(recent).toHaveLength(3)
    expect(older).toHaveLength(msgs.length - 3)
  })

  it('sem instrução de user identificável, com 0 sumariza tudo', () => {
    const msgs = [{ role: 'assistant' as const, content: 'só assistente' }]
    expect(splitForCompaction(msgs, 0)).toEqual({ older: msgs, recent: [] })
  })
})

describe('compactNow', () => {
  // Com N explícito — a forma que o `/compact` manual usa. O default é 0.
  it('com N explícito, sumariza SÓ a parte antiga e devolve [sumário, ...N turnos]', async () => {
    const msgs = conversation(6)
    const compactFn = jest.fn(async (_messages: Msg[], _systemPrompt: string) => 'SUMÁRIO')

    const out = await compactNow(msgs, 'system', compactFn, 3)

    // O sumarizador nunca vê os turnos preservados — se visse, o conteúdo
    // ficaria duplicado (resumido E literal) e o pedido seria maior.
    const summarized = compactFn.mock.calls[0][0]
    expect(summarized.some(m => m.content === 'resposta 5')).toBe(false)
    const asText = (m: Msg): string =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map(b => (b.type === 'tool_result' ? b.content : '')).join('')

    expect(out).not.toBeNull()
    // Sumarizado + preservado reconstroem o histórico: nada se perde em
    // silêncio no corte.
    const preserved = out!.slice(1)
    expect(summarized.length + preserved.length).toBe(msgs.length)
    expect([...summarized, ...preserved].map(asText)).toEqual(msgs.map(asText))
    expect(out![0].role).toBe('user')
    expect(out![0].content).toContain('SUMÁRIO')
    expect(out!.slice(1).map(asText)).toEqual([
      'resposta 3', 'tool result 3',
      'pergunta 4', 'resposta 4', 'tool result 4',
      'pergunta 5', 'resposta 5', 'tool result 5',
    ])
  })

  it('avisa o modelo de que os turnos recentes vêm literais a seguir', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S', 3)
    // Sem este aviso o modelo trata o resumo como tudo o que sabe e volta a
    // ler ficheiros cujos resultados estão logo abaixo, intactos.
    expect(out![0].content).toContain('EARLIER portion only')
    expect(out![0].content).toContain('do not re-read')
  })

  it('com 0, o resultado é [sumário, instrução actual, …]', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S', 0)
    expect(out![1].content).toBe('pergunta 5')
    expect(out).toHaveLength(4)
  })

  // O marco de fronteira anunciava "0 mensagens sumarizadas" numa compactação
  // que libertou 65% do contexto (sessão real, 2026-08-06): era uma constante
  // escrita à mão no agentService. Aqui trava-se a aritmética que a substitui.
  it('a contagem de sumarizadas é messages − preservadas', async () => {
    const msgs = conversation(6)            // 18 mensagens
    const out = await compactNow(msgs, 'system', async () => 'S', 2)
    const preservadas = out!.length - 1     // sem o sumário
    expect(msgs.length - preservadas).toBe(msgs.length - 5)
    expect(preservadas).toBe(5)
  })

  it('sumarizador vazio devolve null (o caller conta a falha)', async () => {
    expect(await compactNow(conversation(6), 'system', async () => null)).toBeNull()
  })

  // O default é 0 desde 2026-08-06 — ver o cabeçalho. O que protege o estado
  // de trabalho é o buildPostCompactRecoveryBlock, não turnos crus; se alguém
  // voltar a pôr >0 para "corrigir" perda de contexto, o sítio a olhar é a
  // recuperação, não isto.
  it('o default sumariza tudo MENOS a instrução actual', async () => {
    expect(KEEP_RECENT_TURNS_ON_COMPACT).toBe(0)
    const out = await compactNow(conversation(10), 'system', async () => 'S')
    expect(out![1].content).toBe('pergunta 9')
    expect(out!.length).toBeLessThan(6)
  })
})
