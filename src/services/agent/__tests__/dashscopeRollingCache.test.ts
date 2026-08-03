/**
 * Cache incremental do histórico no DashScope (2026-07-31).
 *
 * Só se marcava o bloco de system, portanto o prefixo cacheado congelava aí e
 * todo o histórico era refaturado a preço cheio a cada turno — o sintoma medido
 * na sessão katondo-queue (12,36M tokens de input, valor cacheado parado nos
 * 31.808 desde o turno 11).
 *
 * O contrato vem da documentação do Alibaba Model Studio ("Context Cache" +
 * "显式缓存最佳实践"): marcador aceite em system/user/assistant/tool, máximo 4 por
 * pedido, mínimo 1024 tokens por bloco, e para multi-turno marca-se o último
 * objecto de conteúdo de cada turno.
 */
import { applyDashScopePromptCacheForByok } from '../dashscopePromptCache'

const HOST = 'dashscope.aliyuncs.com'
const MODEL = 'qwen3.7-max'
const BIG_SYSTEM = 'S'.repeat(8000)
const BIG_TEXT = 'conteudo de conversa '.repeat(400) // ~8k chars

type Part = { type: string; text?: string; cache_control?: unknown }
type Msg = { role: string; content: unknown; tool_calls?: unknown }

function body(messages: Msg[], model = MODEL): Record<string, unknown> {
  return { model, messages }
}

function markersIn(b: Record<string, unknown>): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = []
  for (const msg of b.messages as Msg[]) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Part[]) {
      if (part && 'cache_control' in part) {
        out.push({ role: msg.role, text: String(part.text ?? '').slice(0, 20) })
      }
    }
  }
  return out
}

describe('marcador rolante na última mensagem', () => {
  it('marca o system E a última mensagem — não só o system', () => {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: BIG_TEXT },
    ])
    expect(applyDashScopePromptCacheForByok(b, HOST)).toBe(true)
    const marks = markersIn(b)
    expect(marks.map(m => m.role)).toEqual(['system', 'user'])
  })

  it('não passa dos 4 marcadores por pedido', () => {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: BIG_TEXT },
      { role: 'assistant', content: BIG_TEXT },
      { role: 'user', content: BIG_TEXT },
    ])
    applyDashScopePromptCacheForByok(b, HOST)
    expect(markersIn(b).length).toBeLessThanOrEqual(4)
  })

  it('salta uma mensagem de assistant sem conteúdo (só tool_calls) e marca a anterior', () => {
    // Content nulo não pode carregar o marcador; marcá-lo às cegas produziria um
    // bloco inválido no corpo.
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: BIG_TEXT },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
    ])
    applyDashScopePromptCacheForByok(b, HOST)
    const marks = markersIn(b)
    expect(marks.map(m => m.role)).toEqual(['system', 'user'])
  })

  it('marca a mensagem de tool (resultados) — a doc aceita role tool', () => {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: 'ok' },
      { role: 'tool', content: BIG_TEXT },
    ])
    applyDashScopePromptCacheForByok(b, HOST)
    expect(markersIn(b).some(m => m.role === 'tool')).toBe(true)
  })

  it('num conteúdo multimodal escolhe um bloco de TEXTO, nunca a imagem', () => {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: BIG_TEXT },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ])
    applyDashScopePromptCacheForByok(b, HOST)
    const userParts = (b.messages as Msg[])[1].content as Part[]
    expect(userParts[0].cache_control).toBeDefined()
    expect(userParts[1].cache_control).toBeUndefined()
  })

  it('histórico curto NÃO leva marcador — abaixo de 1024 tokens é premium pago a troco de nada', () => {
    // Criar cache custa 125% do input; um marcador ignorado é só custo.
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: 'oi' },
    ])
    applyDashScopePromptCacheForByok(b, HOST)
    expect(markersIn(b).map(m => m.role)).toEqual(['system'])
  })

  it('modelo sem cache explícito não recebe marcador nenhum', () => {
    const b = body(
      [
        { role: 'system', content: BIG_SYSTEM },
        { role: 'user', content: BIG_TEXT },
      ],
      'modelo-desconhecido',
    )
    applyDashScopePromptCacheForByok(b, HOST)
    expect(markersIn(b)).toEqual([])
  })

  it('host que não é DashScope fica intacto', () => {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: BIG_TEXT },
    ])
    expect(applyDashScopePromptCacheForByok(b, 'api.openai.com')).toBe(false)
    expect(markersIn(b)).toEqual([])
  })

  it('é idempotente — reaplicar não duplica marcadores', () => {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: BIG_TEXT },
    ])
    applyDashScopePromptCacheForByok(b, HOST)
    const first = markersIn(b).length
    applyDashScopePromptCacheForByok(b, HOST)
    expect(markersIn(b).length).toBe(first)
  })
})
