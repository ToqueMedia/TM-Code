import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDashScopePromptCache } from '../src/dashscopePromptCache'

/**
 * Marcador rolante no caminho GERIDO (2026-08-10).
 *
 * O gémeo do IDE recebeu isto a 2026-07-31, mas só serve o caminho BYOK. Todos
 * os utilizadores sem BYOK passam por este worker, que ficou na versão que só
 * marcava o bloco de system — logo o prefixo cacheado congelava aí e todo o
 * histórico era refacturado a preço cheio a cada turno.
 *
 * Sintoma medido na sessão golive (qwen3.7-plus, persona standard):
 * `cacheReadInputTokens` parado em 25.111 em 43 pedidos, com o input a crescer
 * de 30.726 para 98.311 — 2,68M de input com 40% de cache-read.
 *
 * Contrato (Model Studio, "Context Cache"): marcador em system/user/assistant/
 * tool, máximo 4 por pedido, mínimo 1024 tokens por bloco, e para multi-turno
 * marca-se o último objecto de conteúdo de cada turno.
 */

/** A região REALMENTE em serviço é a US (confirmado pelo developer 2026-08-10). */
const DASHSCOPE = { provider: 'dashscope', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' }
const MODEL = 'qwen3.7-plus'
const BIG_SYSTEM = 'S'.repeat(8192)
const BIG_TEXT = 'conteudo de conversa '.repeat(400) // ~8k chars

type Part = { type?: string; text?: string; cache_control?: unknown }
type Msg = { role: string; content: unknown; tool_calls?: unknown }

function body(messages: Msg[], model = MODEL): Record<string, unknown> {
  return { model, messages }
}

function markersIn(b: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const msg of b.messages as Msg[]) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Part[]) {
      if (part && typeof part === 'object' && 'cache_control' in part) out.push(msg.role)
    }
  }
  return out
}

test('marca o system E a última mensagem — não só o system', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: BIG_TEXT },
  ])
  const stats = applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL })

  assert.equal(stats.cacheControlApplied, true)
  assert.equal(stats.rollingMarkerApplied, true)
  assert.deepEqual(markersIn(b), ['system', 'user'])
})

test('o marcador rola para a mensagem mais recente a cada turno', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: BIG_TEXT },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', content: 'resultado da ferramenta' },
  ])
  applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL })

  assert.deepEqual(markersIn(b), ['system', 'tool'])
})

test('salta a mensagem de assistant que só traz tool_calls (content nulo)', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: BIG_TEXT },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' }] },
  ])
  applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL })

  assert.deepEqual(markersIn(b), ['system', 'user'])
})

test('marca um bloco de TEXTO, nunca um de imagem', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: BIG_TEXT },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ])
  applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL })

  const parts = (b.messages as Msg[])[1].content as Part[]
  assert.equal(parts[0].cache_control !== undefined, true)
  assert.equal(parts[1].cache_control, undefined)
})

test('histórico curto não é marcado — um bloco abaixo de 1024 tokens é ignorado e cobrado a 125%', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: 'olá' },
  ])
  const stats = applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL })

  assert.equal(stats.rollingMarkerApplied, false)
  assert.deepEqual(markersIn(b), ['system'])
})

test('modelo sem suporte a cache explícito não leva marcador rolante', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: BIG_TEXT },
  ], 'modelo-desconhecido')
  const stats = applyDashScopePromptCache(b, { ...DASHSCOPE, model: 'modelo-desconhecido' })

  assert.equal(stats.rollingMarkerApplied, false)
  assert.deepEqual(markersIn(b), [])
})

test('provider não-DashScope não é tocado', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: BIG_TEXT },
  ])
  const stats = applyDashScopePromptCache(b, {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  })

  assert.equal(stats.rollingMarkerApplied, false)
  assert.deepEqual(markersIn(b), [])
})

test('nunca ultrapassa o limite de 4 marcadores por pedido', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: BIG_TEXT, cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'text', text: BIG_TEXT, cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'text', text: BIG_TEXT, cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: BIG_TEXT },
  ])
  applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL })

  assert.equal(markersIn(b).length <= 4, true, `esperava <=4 marcadores, veio ${markersIn(b).length}`)
})

/**
 * O sidecar de IMAGEM não leva marcadores de chat (2026-08-11).
 *
 * `applyDashScopePromptCache` corre em TODOS os pedidos, incluindo os que o
 * `X-Request-Type: image` encaminha para o sidecar de geração. Esse caminho
 * fala a API NATIVA da DashScope — a geração de imagens não existe no modo
 * OpenAI-compatible (404 verificado ao vivo 2026-08-08, ver activeConfig.ts).
 *
 * O marcador rolante converte o `content` da última mensagem num array de
 * blocos com `cache_control`, forma que essa API não conhece. Defeito
 * introduzido com o próprio marcador rolante: antes só se tocava no bloco de
 * system, que os corpos de imagem não têm.
 */
test('pedido de imagem não é tocado', () => {
  const b = body([
    { role: 'system', content: BIG_SYSTEM },
    { role: 'user', content: BIG_TEXT },
  ])
  const stats = applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL, requestType: 'image' })

  assert.equal(stats.rollingMarkerApplied, false)
  assert.equal(stats.cacheControlApplied, false)
  assert.deepEqual(markersIn(b), [])
  // E o content continua STRING, não um array de blocos.
  assert.equal(typeof (b.messages as Msg[])[1].content, 'string')
})

test('os outros tipos de pedido continuam a ser marcados', () => {
  for (const rt of [null, undefined, 'utility', 'vision']) {
    const b = body([
      { role: 'system', content: BIG_SYSTEM },
      { role: 'user', content: BIG_TEXT },
    ])
    applyDashScopePromptCache(b, { ...DASHSCOPE, model: MODEL, requestType: rt as string | null })
    assert.deepEqual(markersIn(b), ['system', 'user'], `requestType=${rt}`)
  }
})
