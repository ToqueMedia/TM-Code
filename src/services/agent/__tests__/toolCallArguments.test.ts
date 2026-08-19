import {
  coerceArgumentChunk,
  coerceFunctionArguments,
  isValidJsonString,
  repairPartialJson,
  sanitizeAssistantToolCalls,
} from '../toolCallArguments'
import { toOpenAIMessages, type QueryMessage } from '../query'

describe('coerceFunctionArguments', () => {
  it('objecto vira string JSON', () => {
    expect(coerceFunctionArguments({ file_path: 'src/a.ts' })).toBe('{"file_path":"src/a.ts"}')
    expect(isValidJsonString(coerceFunctionArguments({ file_path: 'src/a.ts' }))).toBe(true)
  })

  it('string válida fica igual', () => {
    const raw = '{"query":"foo"}'
    expect(coerceFunctionArguments(raw)).toBe(raw)
  })

  it('vazio / [object Object] / null viram {}', () => {
    expect(coerceFunctionArguments(null)).toBe('{}')
    expect(coerceFunctionArguments('')).toBe('{}')
    expect(coerceFunctionArguments('[object Object]')).toBe('{}')
  })

  it('JSON truncado pelo stream fecha e parseia', () => {
    const truncated = '{"file_path":"/Users/x/src/App.tsx","old_string":"const x ='
    const repaired = coerceFunctionArguments(truncated)
    expect(isValidJsonString(repaired)).toBe(true)
    const parsed = JSON.parse(repaired) as { file_path?: string }
    expect(parsed.file_path).toBe('/Users/x/src/App.tsx')
  })

  it('lixo irreparável não rebenta — devolve {}', () => {
    expect(coerceFunctionArguments('not-json-at-all {')).toBe('{}')
  })
})

describe('repairPartialJson', () => {
  it('fecha array e objecto', () => {
    expect(repairPartialJson('{"a":[1,2')).toBe('{"a":[1,2]}')
  })

  it('lixo devolve null', () => {
    expect(repairPartialJson(':::')).toBeNull()
  })
})

describe('coerceArgumentChunk', () => {
  it('objecto no último delta não vira [object Object]', () => {
    expect(coerceArgumentChunk({ q: 1 })).toBe('{"q":1}')
    expect(coerceArgumentChunk('{"q":')).toBe('{"q":')
  })
})

describe('sanitizeAssistantToolCalls + toOpenAIMessages', () => {
  it('o fio para o Cloudflare nunca leva arguments inválidos no _native', () => {
    const queryMsg: QueryMessage = {
      role: 'assistant',
      content: '',
      _native: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_bad',
            type: 'function',
            function: {
              name: 'Edit',
              arguments: '{"file_path":"a.ts","old_string":"foo',
            },
          },
        ],
      },
    }
    const api = toOpenAIMessages([
      queryMsg,
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_bad', content: 'ok' }],
      },
    ])
    const args = (api[0] as { tool_calls?: Array<{ function?: { arguments?: string } }> })
      .tool_calls?.[0]?.function?.arguments
    expect(typeof args).toBe('string')
    expect(isValidJsonString(args!)).toBe(true)
    expect(api.some((m) => (m as { role?: string }).role === 'tool')).toBe(true)
  })

  it('arguments já objecto no native são stringify no fio', () => {
    const sanitized = sanitizeAssistantToolCalls({
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'Read', arguments: { file_path: 'x' } } },
      ],
    })
    expect(sanitized.tool_calls[0].function.arguments).toBe('{"file_path":"x"}')
  })
})
