/**
 * Tests for the Anthropic ⇄ OpenAI shape adapter (BYOK direct routing).
 * The streaming tool-call translation is the highest-risk piece — block-index
 * bookkeeping + input_json_delta reassembly — so it gets a recorded transcript.
 */

// jsdom doesn't always expose Node's web-stream / encoder globals — polyfill
// before importing the module under test.
import { TextEncoder as NodeTE, TextDecoder as NodeTD } from 'util'
import { TransformStream as NodeTS, ReadableStream as NodeRS } from 'node:stream/web'
const g = globalThis as unknown as Record<string, unknown>
if (typeof g.TextEncoder === 'undefined') g.TextEncoder = NodeTE
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = NodeTD
if (typeof g.TransformStream === 'undefined') g.TransformStream = NodeTS as unknown
if (typeof g.ReadableStream === 'undefined') g.ReadableStream = NodeRS as unknown

import {
  toAnthropicRequest,
  anthropicResponseToOpenAI,
  anthropicSSEToOpenAISSE,
} from '../anthropicAdapter'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../contextBuilder/helpers'

describe('toAnthropicRequest', () => {
  it('extracts the system message into the top-level system field', () => {
    const out = toAnthropicRequest({
      model: 'claude-opus-4-8',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    })
    expect(out.system).toBe('You are helpful.')
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }])
  })

  it('maps assistant tool_calls to tool_use and tool results to a user tool_result', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'file contents' },
      ],
    })
    const messages = out.messages as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
    })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file contents' }],
    })
  })

  it('coalesces adjacent same-role turns so roles strictly alternate', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'a', content: 'r1' },
        { role: 'tool', tool_call_id: 'b', content: 'r2' },
      ],
    })
    const messages = out.messages as Array<Record<string, unknown>>
    // The two tool results collapse into ONE user turn (Anthropic alternation).
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('user')
    expect((messages[1].content as unknown[]).length).toBe(2)
  })

  it('converts tool definitions to input_schema and marks the last with a cache breakpoint', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'function', function: { name: 'read_file', description: 'reads', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
        { type: 'function', function: { name: 'write_file', description: 'writes', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      ],
    })
    expect(out.tools).toEqual([
      { name: 'read_file', description: 'reads', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'write_file', description: 'writes', input_schema: { type: 'object', properties: { path: { type: 'string' } } }, cache_control: { type: 'ephemeral' } },
    ])
  })

  it('passes thinking through and bumps max_tokens above the budget', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 8192 },
      output_config: { effort: 'high' },
    })
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(out.output_config).toEqual({ effort: 'high' })
    expect(out.max_tokens as number).toBeGreaterThan(8192)
  })

  it('splits the system on the dynamic boundary into a cached static block + uncached dynamic block', () => {
    const staticPart = 'You are a helpful agent. Stable rules here.'
    const dynamicPart = 'Current file tree and git status.'
    const out = toAnthropicRequest({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: `${staticPart}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicPart}` },
        { role: 'user', content: 'Hi' },
      ],
    })
    expect(out.system).toEqual([
      { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicPart },
    ])
  })

  it('leaves a SHORT boundary-less system as a plain string (one-shot side-calls)', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    })
    // Under Anthropic's minimum cacheable prefix a breakpoint would be ignored,
    // so compact/title one-shots must not pay the cache-WRITE premium.
    expect(out.system).toBe('You are helpful.')
  })

  it('caches a LARGE boundary-less system whole (FASE B: the marker never arrives)', () => {
    // Regression guard for the auditoria 2026-07-28 P0: FASE B moved the split
    // to build time, so `found:false` became the NORMAL case — and the old code
    // silently degraded it to "no cache_control at all", re-billing the whole
    // system prompt on every turn.
    const bigSystem = 'You are a coding agent. '.repeat(400)
    const out = toAnthropicRequest({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: bigSystem },
        { role: 'user', content: 'Hi' },
      ],
    })
    expect(out.system).toEqual([
      { type: 'text', text: bigSystem, cache_control: { type: 'ephemeral' } },
    ])
  })

  it('marks the last message block for incremental history caching when tools are sent', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    })
    const messages = out.messages as Array<{ content: Array<Record<string, unknown>> }>
    const last = messages[messages.length - 1].content.slice(-1)[0]
    expect(last.cache_control).toEqual({ type: 'ephemeral' })
    // Earlier turns keep no breakpoint of their own — the prefix is implied.
    expect(messages[0].content[0].cache_control).toBeUndefined()
  })

  it('devolve os blocos de thinking assinados PRIMEIRO no turno do assistant', () => {
    // Com `thinking: enabled` + tool use a Messages API EXIGE que os blocos
    // assinados voltem; sem isto todo o loop de tools BYOK-Anthropic com
    // thinking era rejeitado (auditoria 2026-07-28).
    const out = toAnthropicRequest({
      model: 'claude-opus-4-8',
      max_tokens: 1000,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [
        { role: 'user', content: 'porquê?' },
        {
          role: 'assistant',
          content: 'porque sim',
          thinking_blocks: [{ type: 'thinking', thinking: 'deixa ver…', signature: 'sig-abc' }],
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 't1', content: 'ficheiro' },
      ],
    })
    const messages = out.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const assistant = messages.find((m) => m.role === 'assistant')!
    expect(assistant.content[0]).toEqual({
      type: 'thinking', thinking: 'deixa ver…', signature: 'sig-abc',
    })
    // ...e o resto do turno mantém-se, pela ordem certa.
    expect(assistant.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
  })

  it('does NOT mark message blocks when no tools are sent (one-shot payloads)', () => {
    const out = toAnthropicRequest({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'summarize this' }],
    })
    const messages = out.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages[0].content[0].cache_control).toBeUndefined()
  })
})

describe('anthropicResponseToOpenAI (non-stream)', () => {
  it('translates a Messages response to a ChatCompletion', () => {
    const out = anthropicResponseToOpenAI({
      id: 'msg_1',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3 },
    })
    const choice = (out.choices as Array<Record<string, unknown>>)[0]
    const message = choice.message as Record<string, unknown>
    expect(message.content).toBe('done')
    expect(choice.finish_reason).toBe('stop')
    expect(out.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
  })

  it('propagates Anthropic prompt-cache usage fields when present', () => {
    const out = anthropicResponseToOpenAI({
      id: 'msg_2',
      content: [{ type: 'text', text: 'cached' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1200,
        output_tokens: 50,
        cache_creation_input_tokens: 47000,
        cache_read_input_tokens: 0,
      },
    })
    expect(out.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 50,
      total_tokens: 1250,
      cache_creation_input_tokens: 47000,
      cache_read_input_tokens: 0,
    })
  })
})

describe('anthropicSSEToOpenAISSE (streaming)', () => {
  const ANTHROPIC_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')

  async function drive(sse: string): Promise<{ chunks: Record<string, unknown>[]; sawDone: boolean }> {
    const ts = anthropicSSEToOpenAISSE()
    const writer = ts.writable.getWriter()
    const reader = ts.readable.getReader()
    const enc = new TextEncoder()
    // Write + close WITHOUT awaiting first — a TransformStream applies
    // backpressure to writable until readable is drained, so we must read
    // concurrently or write() deadlocks.
    const writeDone = (async () => {
      await writer.write(enc.encode(sse))
      await writer.close()
    })()

    const dec = new TextDecoder()
    let out = ''
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      out += dec.decode(value as Uint8Array, { stream: true })
    }
    await writeDone
    const chunks: Record<string, unknown>[] = []
    let sawDone = false
    for (const line of out.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') { sawDone = true; continue }
      chunks.push(JSON.parse(payload))
    }
    return { chunks, sawDone }
  }

  it('reassembles text, a streamed tool call, finish_reason and usage', async () => {
    const { chunks, sawDone } = await drive(ANTHROPIC_SSE)

    // Concatenated text content.
    const text = chunks
      .map((c) => ((c.choices as any[])?.[0]?.delta?.content as string) ?? '')
      .join('')
    expect(text).toBe('Hello')

    // Tool call: name from content_block_start, args reassembled from deltas.
    let toolName = ''
    let toolArgs = ''
    let toolIndex = -1
    for (const c of chunks) {
      const tc = (c.choices as any[])?.[0]?.delta?.tool_calls?.[0]
      if (!tc) continue
      if (tc.function?.name) { toolName = tc.function.name; toolIndex = tc.index }
      if (tc.function?.arguments) toolArgs += tc.function.arguments
    }
    expect(toolName).toBe('read_file')
    expect(toolIndex).toBe(0)
    expect(JSON.parse(toolArgs)).toEqual({ path: 'a.ts' })

    // finish_reason + usage on the final chunk.
    const finishChunk = chunks.find((c) => (c.choices as any[])?.[0]?.finish_reason)
    expect((finishChunk!.choices as any[])[0].finish_reason).toBe('tool_calls')
    expect(finishChunk!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

    expect(sawDone).toBe(true)
  })

  it('propagates prompt-cache usage from message_start to the final usage chunk (cache create on first turn)', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1200,"output_tokens":0,"cache_creation_input_tokens":47000,"cache_read_input_tokens":0}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')
    const { chunks } = await drive(sse)
    const finishChunk = chunks.find((c) => (c.choices as any[])?.[0]?.finish_reason)
    expect(finishChunk!.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 5,
      total_tokens: 1205,
      cache_creation_input_tokens: 47000,
      cache_read_input_tokens: 0,
    })
  })

  it('reports cache_read_input_tokens on a cache HIT (subsequent turn)', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":1200,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":47000}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi again"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')
    const { chunks } = await drive(sse)
    const finishChunk = chunks.find((c) => (c.choices as any[])?.[0]?.finish_reason)
    expect(finishChunk!.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 3,
      total_tokens: 1203,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 47000,
    })
  })
})
