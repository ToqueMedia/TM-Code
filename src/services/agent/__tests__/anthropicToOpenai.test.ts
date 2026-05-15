import { anthropicToOpenAIBody } from '../anthropicToOpenai'

describe('anthropicToOpenAIBody — system handling', () => {
  test('string system becomes a "system" message', () => {
    const body = anthropicToOpenAIBody(
      { system: 'You are a helpful assistant.', messages: [{ role: 'user', content: 'hi' }] },
      'qwen3:8b',
    ) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  test('array-of-text-blocks system gets flattened to one string', () => {
    const body = anthropicToOpenAIBody(
      {
        system: [
          { type: 'text', text: 'You are TM Code.\n' },
          { type: 'text', text: 'Be concise.' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
      'qwen3:8b',
    ) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are TM Code.\nBe concise.' })
  })

  test('empty / absent system produces no system message', () => {
    const body = anthropicToOpenAIBody(
      { messages: [{ role: 'user', content: 'hi' }] },
      'qwen3:8b',
    ) as { messages: Array<{ role: string }> }
    expect(body.messages[0].role).toBe('user')
  })

  test('whitespace-only system is dropped', () => {
    const body = anthropicToOpenAIBody(
      { system: '   \n  ', messages: [{ role: 'user', content: 'hi' }] },
      'qwen3:8b',
    ) as { messages: Array<{ role: string }> }
    expect(body.messages[0].role).toBe('user')
  })
})

describe('anthropicToOpenAIBody — content blocks', () => {
  test('assistant tool_use becomes tool_calls', () => {
    const body = anthropicToOpenAIBody(
      {
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'OK' },
              { type: 'tool_use', id: 'call_1', name: 'list', input: { path: '/tmp' } },
            ],
          },
        ],
      },
      'qwen3:8b',
    ) as { messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }> }
    const assistantMsg = body.messages[1]
    expect(assistantMsg.role).toBe('assistant')
    expect(assistantMsg.content).toBe('OK')
    expect(assistantMsg.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'list', arguments: JSON.stringify({ path: '/tmp' }) } },
    ])
  })

  test('user tool_result becomes role:"tool" message before next user turn', () => {
    const body = anthropicToOpenAIBody(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt\nb.txt' },
              { type: 'text', text: 'now read a.txt' },
            ],
          },
        ],
      },
      'qwen3:8b',
    ) as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }
    expect(body.messages[0]).toEqual({ role: 'tool', content: 'a.txt\nb.txt', tool_call_id: 'call_1' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'now read a.txt' })
  })

  test('user content with image becomes multimodal array', () => {
    const body = anthropicToOpenAIBody(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
        ],
      },
      'qwen3:8b',
    ) as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ])
  })
})

describe('anthropicToOpenAIBody — tools', () => {
  test('Anthropic tool def becomes function-shape tool', () => {
    const body = anthropicToOpenAIBody(
      {
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
      'qwen3:8b',
    ) as { tools?: unknown[] }
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ])
  })

  test('empty tools list is omitted from body', () => {
    const body = anthropicToOpenAIBody(
      { messages: [{ role: 'user', content: 'hi' }] },
      'qwen3:8b',
    )
    expect('tools' in body).toBe(false)
  })
})

describe('anthropicToOpenAIBody — required fields', () => {
  test('always sets stream=true and stream_options.include_usage', () => {
    const body = anthropicToOpenAIBody(
      { messages: [{ role: 'user', content: 'hi' }] },
      'qwen3:8b',
    ) as { stream: boolean; stream_options: { include_usage: boolean }; model: string }
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.model).toBe('qwen3:8b')
  })

  test('preserves max_tokens / temperature / top_p when present', () => {
    const body = anthropicToOpenAIBody(
      { messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096, temperature: 0.6, top_p: 0.95 },
      'qwen3:8b',
    ) as { max_tokens: number; temperature: number; top_p: number }
    expect(body.max_tokens).toBe(4096)
    expect(body.temperature).toBe(0.6)
    expect(body.top_p).toBe(0.95)
  })
})
