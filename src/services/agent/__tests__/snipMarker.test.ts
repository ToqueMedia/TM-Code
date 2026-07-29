import { snipCompactIfNeeded } from '../compact/snipCompact'

/**
 * Um snip sem marcador é amnésia com cara de conversa completa.
 *
 * O snip corta o INÍCIO do histórico e, ao contrário do auto-compact, não
 * resume nada — o conteúdo desaparece. Devolvia `kept` cru, portanto o modelo
 * recebia uma conversa que começava a meio sem qualquer pista de que algo
 * tinha sido removido: re-derivava decisões já tomadas, contradizia acordos
 * anteriores e não pedia o que perdeu, porque não sabia que tinha perdido.
 *
 * O marcador vai no PRIMEIRO bloco da primeira mensagem mantida, e não como
 * mensagem nova, para não criar dois `user` seguidos. `findSafeCutPoint` já
 * garante que essa mensagem é um `user` normal — nunca uma cujo primeiro bloco
 * seja um `tool_result` — o que é a condição para prepender texto ser seguro.
 */
describe('marcador do snip', () => {
  const long = (n: number) => 'x'.repeat(n)

  const history = () => [
    { role: 'user' as const, content: `pedido inicial ${long(4000)}` },
    { role: 'assistant' as const, content: `resposta 1 ${long(4000)}` },
    { role: 'user' as const, content: `pedido 2 ${long(4000)}` },
    { role: 'assistant' as const, content: `resposta 2 ${long(4000)}` },
    { role: 'user' as const, content: 'pedido final' },
  ]

  it('anuncia quantas mensagens desapareceram e que NÃO foram resumidas', () => {
    const out = snipCompactIfNeeded(history(), { force: true, keepRecentMessages: 1 })

    expect(out.messagesRemoved).toBeGreaterThan(0)
    const first = out.messages[0].content as string
    expect(first).toContain('<system-reminder>')
    expect(first).toContain(`${out.messagesRemoved} earlier message`)
    expect(first).toContain('NOT summarized')
    // A instrução accionável: ir buscar em vez de assumir.
    expect(first).toContain('read_session_memory')
    expect(first).toContain('Do not claim to remember what was cut')
  })

  it('preserva o conteúdo da mensagem mantida depois do marcador', () => {
    const out = snipCompactIfNeeded(history(), { force: true, keepRecentMessages: 1 })

    expect(out.messages[0].content as string).toContain('pedido final')
  })

  it('mantém a primeira mensagem no papel `user` (a API exige-o)', () => {
    const out = snipCompactIfNeeded(history(), { force: true, keepRecentMessages: 1 })

    expect(out.messages[0].role).toBe('user')
    // E não acrescenta uma mensagem: o marcador entra na que já lá estava.
    expect(out.messages.length).toBe(history().length - out.messagesRemoved)
  })

  it('não marca nada quando não houve corte', () => {
    const short = [{ role: 'user' as const, content: 'olá' }]
    const out = snipCompactIfNeeded(short, { keepRecentMessages: 20 })

    expect(out.messagesRemoved).toBe(0)
    expect(out.messages[0].content).toBe('olá')
  })

  it('com conteúdo em blocos, o marcador entra como bloco de texto à frente', () => {
    const blocks = [
      { role: 'user' as const, content: `pedido ${long(5000)}` },
      { role: 'assistant' as const, content: `resposta ${long(5000)}` },
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'continua daqui' }],
      },
    ]
    const out = snipCompactIfNeeded(blocks, { force: true, keepRecentMessages: 1 })

    expect(out.messagesRemoved).toBeGreaterThan(0)
    const content = out.messages[0].content as Array<{ type: string; text: string }>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('<system-reminder>')
    // O bloco original sobrevive, na sua ordem.
    expect(content[1].text).toBe('continua daqui')
  })
})
