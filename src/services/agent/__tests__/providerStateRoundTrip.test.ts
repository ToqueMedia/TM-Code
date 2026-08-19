import { toOpenAIMessages, type QueryMessage } from '../query'
import type { ProviderState, ConversationMessage } from '../../../types/chat'
import { toQueryMessages } from '../queryEngine'
import { downgradeHistoryToText } from '../promptValueHelpers'

describe('Provider-native reasoning round-trip', () => {
  // ── Helper: build a ProviderState with a native assistant message ──
  function makeProviderState(
    nativeFields: Record<string, unknown>,
  ): ProviderState {
    return {
      provider: 'test-provider',
      protocol: 'openai-chat',
      nativeAssistantMessage: {
        role: 'assistant',
        ...nativeFields,
      },
      capturedAt: Date.now(),
    }
  }

  // ── Helper: simulate rebuildConversationHistory's _native injection ──
  function rebuildWithNative(
    msg: { content: string; providerState?: ProviderState },
  ): ConversationMessage {
    const native = msg.providerState?.nativeAssistantMessage
    if (native) {
      const nativeContent =
        typeof native.content === 'string' ? native.content : msg.content || ''
      return { role: 'assistant', content: nativeContent, _native: native }
    }
    // Legacy fallback: reconstruct from reasoningContent
    return { role: 'assistant', content: msg.content }
  }

  describe('Caso A — OpenAI-compatible com reasoning_content + tool_calls', () => {
    it('preserves native message through toOpenAIMessages', () => {
      const nativeMsg: Record<string, unknown> = {
        role: 'assistant',
        content: 'Hello, I used a tool.',
        reasoning_content: 'Let me think about which tool to use...',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"src/index.ts"}',
            },
          },
        ],
      }

      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: 'Hello, I used a tool.',
        _native: nativeMsg,
      }

      const apiMessages = toOpenAIMessages([
        queryMsg,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_1',
              content: 'file contents',
            },
          ],
        },
      ])
      const apiMsg = apiMessages[0] as any

      // Native fields are preserved
      expect(apiMsg.role).toBe('assistant')
      expect(apiMsg.content).toBe('Hello, I used a tool.')
      expect(apiMsg.reasoning_content).toBe(
        'Let me think about which tool to use...',
      )
      expect(apiMsg.tool_calls).toHaveLength(1)
      expect(apiMsg.tool_calls[0].id).toBe('call_1')
      expect(apiMsg.tool_calls[0].function.name).toBe('read_file')
      expect((apiMessages[1] as any).role).toBe('tool')
      expect((apiMessages[1] as any).tool_call_id).toBe('call_1')
    })

    it('rebuild produces _native ConversationMessage', () => {
      const providerState = makeProviderState({
        content: 'Response text',
        reasoning_content: 'Thinking...',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'write_file', arguments: '{}' },
          },
        ],
      })

      const rebuilt = rebuildWithNative({
        content: 'Response text',
        providerState,
      })

      expect(rebuilt._native).toBeDefined()
      expect((rebuilt._native as any).reasoning_content).toBe('Thinking...')
      expect((rebuilt._native as any).tool_calls).toHaveLength(1)
    })

    it('UI reasoningContent remains populated alongside providerState', () => {
      // Verify that reasoningContent (for UI) and providerState (for round-trip)
      // are independent layers — both can coexist
      const providerState = makeProviderState({
        content: 'Response',
        reasoning_content: 'Native thinking text',
      })

      // The ChatMessage would have:
      // msg.reasoningContent = 'Native thinking text' (for UI)
      // msg.providerState = providerState (for round-trip)
      // Both are independent and both persist
      expect(providerState.nativeAssistantMessage).toBeDefined()
      expect(
        (providerState.nativeAssistantMessage as any).reasoning_content,
      ).toBe('Native thinking text')
    })
  })

  describe('Caso B — MiniMax M3 com reasoning_details[]', () => {
    it('preserves reasoning_details array with full structure', () => {
      const reasoningDetails = [
        { text: 'First thinking step', type: 'reasoning', signature: 'sig_1' },
        { text: 'Second thinking step', type: 'analysis', signature: 'sig_2' },
        { text: 'Final conclusion', type: 'conclusion' },
      ]

      const nativeMsg: Record<string, unknown> = {
        role: 'assistant',
        content: 'Here is the answer.',
        reasoning_details: reasoningDetails,
      }

      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: 'Here is the answer.',
        _native: nativeMsg,
      }

      const apiMessages = toOpenAIMessages([queryMsg])
      const apiMsg = apiMessages[0] as any

      // reasoning_details array is preserved with all fields intact
      expect(apiMsg.reasoning_details).toHaveLength(3)
      expect(apiMsg.reasoning_details[0]).toEqual(reasoningDetails[0])
      expect(apiMsg.reasoning_details[1]).toEqual(reasoningDetails[1])
      expect(apiMsg.reasoning_details[2]).toEqual(reasoningDetails[2])
      // Signatures and types are preserved
      expect(apiMsg.reasoning_details[0].signature).toBe('sig_1')
      expect(apiMsg.reasoning_details[0].type).toBe('reasoning')
      expect(apiMsg.reasoning_details[1].type).toBe('analysis')
    })

    it('reasoning_details raw items are not flattened to text only', () => {
      const reasoningDetails = [
        {
          text: 'Complex thought',
          type: 'reasoning',
          extra_field: 'preserved',
          nested: { data: 42 },
        },
      ]

      const nativeMsg: Record<string, unknown> = {
        role: 'assistant',
        content: 'Answer',
        reasoning_details: reasoningDetails,
      }

      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: 'Answer',
        _native: nativeMsg,
      }

      const apiMessages = toOpenAIMessages([queryMsg])
      const apiMsg = apiMessages[0] as any

      // Full object structure is preserved, not just .text
      expect(apiMsg.reasoning_details[0].extra_field).toBe('preserved')
      expect(apiMsg.reasoning_details[0].nested).toEqual({ data: 42 })
    })
  })

  describe('Caso C — Campos desconhecidos preservados', () => {
    it('preserves unknown fields in native message', () => {
      const nativeMsg: Record<string, unknown> = {
        role: 'assistant',
        content: 'Response',
        reasoning_content: 'Thinking...',
        custom_provider_field: 'some_value',
        experimental_metadata: { version: 2, flags: ['a', 'b'] },
      }

      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: 'Response',
        _native: nativeMsg,
      }

      const apiMessages = toOpenAIMessages([queryMsg])
      const apiMsg = apiMessages[0] as any

      // Unknown fields are preserved
      expect(apiMsg.custom_provider_field).toBe('some_value')
      expect(apiMsg.experimental_metadata).toEqual({
        version: 2,
        flags: ['a', 'b'],
      })
      // Known fields still present
      expect(apiMsg.reasoning_content).toBe('Thinking...')
    })

    it('preserves unknown fields in tool calls', () => {
      const nativeMsg: Record<string, unknown> = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
            extra_content: { google: { thought_signature: 'sig_abc' } },
            custom_tc_field: 42,
          },
        ],
      }

      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: '',
        _native: nativeMsg,
      }

      const apiMessages = toOpenAIMessages([
        queryMsg,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_1',
              content: 'ok',
            },
          ],
        },
      ])
      const apiMsg = apiMessages[0] as any

      expect(apiMsg.tool_calls[0].extra_content).toEqual({
        google: { thought_signature: 'sig_abc' },
      })
      expect(apiMsg.tool_calls[0].custom_tc_field).toBe(42)
    })

    it('drops stale provider-native tool calls when matching tool results are absent', () => {
      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: 'Stale provider message',
        _native: {
          role: 'assistant',
          content: 'Stale provider message',
          tool_calls: [
            {
              id: 'gemini_call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
      }

      const apiMessages = toOpenAIMessages([
        queryMsg,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'minimax_rejected_id',
              content: 'orphaned result',
            },
          ],
        },
      ])

      expect((apiMessages[0] as any).tool_calls).toBeUndefined()
      expect(apiMessages.some((m: any) => m.role === 'tool')).toBe(false)
    })

    it('downgradeHistoryToText (modelo sem visão) não parte o par _native.tool_calls / tool_result', () => {
      const history: ConversationMessage[] = [
        {
          role: 'assistant',
          content: '',
          _native: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_read',
                type: 'function',
                function: { name: 'Read', arguments: '{"file_path":"src/a.ts"}' },
              },
            ],
          },
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_read',
              content: 'export const a = 1\n'.repeat(80),
            },
          ],
        },
      ]
      const api = toOpenAIMessages(toQueryMessages(downgradeHistoryToText(history)))
      expect((api[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1)
      const toolMsg = api.find((m) => (m as { role?: string }).role === 'tool') as { content?: string } | undefined
      expect(toolMsg?.content).toContain('export const a = 1')
    })
  })

  describe('Caso D — Sessão antiga sem providerState (fallback legacy)', () => {
    it('works without providerState — no crash', () => {
      const rebuilt = rebuildWithNative({
        content: 'Legacy response',
        // No providerState
      })

      expect(rebuilt.role).toBe('assistant')
      expect(rebuilt.content).toBe('Legacy response')
      expect(rebuilt._native).toBeUndefined()
    })

    it('legacy path produces valid OpenAI messages', () => {
      // Simulate a legacy message (no _native) going through toOpenAIMessages
      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: 'Legacy response with no native state',
      }

      const apiMessages = toOpenAIMessages([queryMsg])
      const apiMsg = apiMessages[0]

      expect(apiMsg.role).toBe('assistant')
      expect(apiMsg.content).toBe('Legacy response with no native state')
    })

    it('legacy ContentBlockAPI path still works', () => {
      const queryMsg: QueryMessage = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Legacy thinking' },
          { type: 'text', text: 'Legacy text' },
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'read_file',
            arguments: '{}',
          },
        ],
      }

      const apiMessages = toOpenAIMessages([
        queryMsg,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_1',
              content: 'legacy result',
            },
          ],
        },
      ])
      const apiMsg = apiMessages[0] as any

      // Legacy reconstruction works
      expect(apiMsg.role).toBe('assistant')
      expect(apiMsg.content).toBe('Legacy text')
      expect(apiMsg.reasoning_content).toBe('Legacy thinking')
      expect(apiMsg.tool_calls).toHaveLength(1)
      expect((apiMessages[1] as any).tool_call_id).toBe('call_1')
    })
  })

  describe('toQueryMessages passes _native through', () => {
    it('preserves _native field from ConversationMessage to QueryMessage', () => {
      const history: ConversationMessage[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: 'Hi',
          _native: {
            role: 'assistant',
            content: 'Hi',
            reasoning_content: 'Thinking...',
          },
        },
      ]

      const queryMsgs = toQueryMessages(history)

      expect(queryMsgs[0]._native).toBeUndefined()
      expect(queryMsgs[1]._native).toBeDefined()
      expect(queryMsgs[1]._native!.reasoning_content).toBe('Thinking...')
    })

    it('handles messages without _native gracefully', () => {
      const history: ConversationMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ]

      const queryMsgs = toQueryMessages(history)

      expect(queryMsgs).toHaveLength(2)
      expect(queryMsgs[0]._native).toBeUndefined()
      expect(queryMsgs[1]._native).toBeUndefined()
    })
  })

  describe('User image_url preservation (regression: pasted image never reached the model)', () => {
    it('keeps image_url blocks as multimodal content on a user message', () => {
      const userMsg: QueryMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'O que vês?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }

      const api = toOpenAIMessages([userMsg])

      expect(api).toHaveLength(1)
      const m = api[0] as {
        role: string
        content: Array<{ type: string; image_url?: { url: string } }>
      }
      expect(m.role).toBe('user')
      expect(Array.isArray(m.content)).toBe(true)
      const images = m.content.filter((p) => p.type === 'image_url')
      expect(images).toHaveLength(1)
      expect(images[0].image_url?.url).toBe('data:image/png;base64,AAAA')
      // Text must survive alongside the image.
      expect(m.content.some((p) => p.type === 'text')).toBe(true)
    })

    it('collapses a text-only user array to a plain string', () => {
      const api = toOpenAIMessages([
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ])
      expect(api[0].content).toBe('hello')
    })
  })

  describe('ProviderState type structure', () => {
    it('supports all three native storage fields', () => {
      const state: ProviderState = {
        provider: 'test',
        protocol: 'openai-chat',
        nativeAssistantMessage: { role: 'assistant', content: 'test' },
        nativeContentBlocks: [
          { type: 'thinking', thinking: 'test', signature: 'sig' },
        ],
        nativeResponseOutputItems: [{ type: 'reasoning', id: 'rs_1' }],
        capturedAt: Date.now(),
      }

      expect(state.nativeAssistantMessage).toBeDefined()
      expect(state.nativeContentBlocks).toBeDefined()
      expect(state.nativeResponseOutputItems).toBeDefined()
    })

    it('serializes to JSON without data loss', () => {
      const state: ProviderState = {
        provider: 'dashscope',
        protocol: 'openai-chat',
        nativeAssistantMessage: {
          role: 'assistant',
          content: 'Response',
          reasoning_content: 'Thinking',
          reasoning_details: [{ text: 'step', type: 'reasoning' }],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'test', arguments: '{}' },
            },
          ],
        },
        capturedAt: 1700000000000,
      }

      const json = JSON.stringify(state)
      const deserialized: ProviderState = JSON.parse(json)

      expect(deserialized).toEqual(state)
      expect(deserialized.nativeAssistantMessage).toEqual(
        state.nativeAssistantMessage,
      )
    })
  })
})
