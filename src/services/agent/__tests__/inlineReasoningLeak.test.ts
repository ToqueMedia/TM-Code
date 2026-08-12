import { query, heldTagFragment, earliestOrphanClose, type QueryParams, type QueryStreamEvent } from '../query'

/**
 * Fuga de `</think>` para o texto visível (auditoria da sessão golive, 2026-08-10).
 *
 * O qwen3.7-plus manda o raciocínio em `reasoning_content` E fecha-o com um
 * `</think>` cru em `delta.content`. A abertura nunca passa pela máquina de
 * estados do stream, portanto `thinkMode` é false — e `indexOf("<think>")` não
 * casa com `</think>`, porque o `<` é seguido de `/`. O fecho caía no ramo
 * "all text is safe" e era emitido para a UI: 14 fugas mais um bloco
 * `<thinking>` inteiro em 4 das 5 mensagens da sessão.
 *
 * `stripInlineReasoning` (completionText.ts) já tratava o fecho órfão, mas só
 * serve os caminhos NÃO-streaming. O chat tem esta máquina própria.
 */

function makeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeStreamingCreate(chunks: unknown[]) {
  return jest.fn(() => ({
    withResponse: async () => ({
      data: makeStream(chunks),
      response: { headers: new Headers() },
    }),
  }))
}

function paramsFor(chunks: unknown[]): QueryParams {
  return {
    messages: [],
    systemPrompt: 'system',
    client: { chat: { completions: { create: makeStreamingCreate(chunks) } } } as unknown as QueryParams['client'],
    model: 'qwen3.7-plus',
    tools: [],
    executeTool: jest.fn(),
    signal: new AbortController().signal,
  }
}

async function collect(chunks: unknown[]): Promise<{ text: string; thinking: string }> {
  const generator = query(paramsFor(chunks))
  let text = ''
  let thinking = ''
  for (;;) {
    const next = await generator.next()
    if (next.done) break
    const event = next.value as QueryStreamEvent
    if (event.type === 'text_delta') text += event.text
    if (event.type === 'thinking_delta') thinking += event.thinking
  }
  return { text, thinking }
}

const STOP = { choices: [{ delta: {}, finish_reason: 'stop' }] }

describe('fecho de raciocínio órfão no stream', () => {
  it('NÃO emite </think> como texto quando o raciocínio veio em reasoning_content', async () => {
    const { text, thinking } = await collect([
      { choices: [{ delta: { reasoning_content: 'o utilizador quer X' } }] },
      { choices: [{ delta: { content: '\n</think>\n\nVou investigar o problema.' } }] },
      STOP,
    ])

    expect(text).not.toContain('</think>')
    expect(text.trim()).toBe('Vou investigar o problema.')
    expect(thinking).toContain('o utilizador quer X')
  })

  it('o que vem antes do fecho órfão conta como raciocínio, não como resposta', async () => {
    const { text, thinking } = await collect([
      { choices: [{ delta: { content: 'divagação sem abertura</think>Resposta final.' } }] },
      STOP,
    ])

    expect(text).toBe('Resposta final.')
    expect(thinking).toBe('divagação sem abertura')
  })

  it('trata </thought> órfão da mesma forma', async () => {
    const { text } = await collect([
      { choices: [{ delta: { content: 'ruido</thought>Feito.' } }] },
      STOP,
    ])

    expect(text).toBe('Feito.')
  })

  it('não estraga o par completo <think>…</think> — o caso que já funcionava', async () => {
    const { text, thinking } = await collect([
      { choices: [{ delta: { content: '<think>a pensar</think>A resposta é 42.' } }] },
      STOP,
    ])

    expect(text).toBe('A resposta é 42.')
    expect(thinking).toBe('a pensar')
  })

  it('vários fechos órfãos seguidos são todos removidos', async () => {
    const { text } = await collect([
      { choices: [{ delta: { content: '</think>\nPrimeiro.' } }] },
      { choices: [{ delta: { content: '\n</think>\nSegundo.' } }] },
      STOP,
    ])

    expect(text).not.toContain('</think>')
    expect(text).toContain('Primeiro.')
    expect(text).toContain('Segundo.')
  })

  it('texto normal com < e / não é confundido com uma tag', async () => {
    const { text } = await collect([
      { choices: [{ delta: { content: 'usa a<b e </div> no JSX' } }] },
      STOP,
    ])

    expect(text).toBe('usa a<b e </div> no JSX')
  })
})

describe('tag partida entre chunks de SSE', () => {
  /**
   * LIMITE ASSUMIDO: texto já emitido não se desfaz.
   *
   * A regra "o que vem antes de um fecho órfão é raciocínio" só se aplica ao
   * que ainda está no buffer. Se o texto anterior saiu num chunk e o fecho só
   * chega no seguinte, o texto já foi para a UI. Reter texto à espera de um
   * fecho que talvez nunca venha seria o mesmo que não fazer streaming.
   *
   * A garantia que interessa — e que o defeito violava — é a TAG nunca sair.
   * No caso real (qwen3.7-plus) o `</think>` abre o `content`, portanto não há
   * texto anterior nenhum a reclassificar.
   */
  it('não deixa passar </think> partido em dois chunks', async () => {
    const { text } = await collect([
      { choices: [{ delta: { content: 'ruido</thi' } }] },
      { choices: [{ delta: { content: 'nk>Resposta.' } }] },
      STOP,
    ])

    expect(text).not.toContain('think')
    expect(text).not.toContain('<')
    expect(text).toBe('ruidoResposta.')
  })

  it('não deixa passar <think> partido em dois chunks', async () => {
    const { text, thinking } = await collect([
      { choices: [{ delta: { content: '<thi' } }] },
      { choices: [{ delta: { content: 'nk>oculto</think>visível' } }] },
      STOP,
    ])

    expect(text).toBe('visível')
    expect(thinking).toBe('oculto')
  })

  it('um fragmento retido que afinal era texto é descarregado no fim do stream', async () => {
    const { text } = await collect([
      { choices: [{ delta: { content: 'o operador <' } }] },
      STOP,
    ])

    expect(text).toBe('o operador <')
  })
})

describe('heldTagFragment', () => {
  it('retém sufixos que ainda podem ser tag', () => {
    expect(heldTagFragment('texto <')).toBe('<')
    expect(heldTagFragment('texto <thi')).toBe('<thi')
    expect(heldTagFragment('texto </thou')).toBe('</thou')
  })

  it('não retém uma tag já completa', () => {
    expect(heldTagFragment('texto <think>')).toBe('')
    expect(heldTagFragment('texto </think>')).toBe('')
  })

  it('não retém texto que não parece tag', () => {
    expect(heldTagFragment('texto normal')).toBe('')
    expect(heldTagFragment('a < b')).toBe('')
    expect(heldTagFragment('')).toBe('')
  })
})

describe('earliestOrphanClose', () => {
  it('detecta um fecho sem abertura', () => {
    expect(earliestOrphanClose('abc</think>def', -1)).toEqual({ idx: 3, len: 8 })
    expect(earliestOrphanClose('abc</thought>def', -1)).toEqual({ idx: 3, len: 10 })
  })

  it('ignora o fecho que pertence a uma abertura anterior', () => {
    expect(earliestOrphanClose('<think>a</think>b', 0)).toBeNull()
  })

  it('devolve null quando não há fecho', () => {
    expect(earliestOrphanClose('texto normal', -1)).toBeNull()
  })
})
