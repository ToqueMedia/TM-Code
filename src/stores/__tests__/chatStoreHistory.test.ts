/**
 * Regression tests for rebuildConversationHistory — the per-internal-turn
 * round-trip (providerStates[]).
 *
 * Background (context pollution audit, 2026-06-12): a single user request can
 * produce N internal assistant turns, all collapsed into one ChatMessage
 * bubble. The old rebuild emitted ONE assistant message carrying only the
 * LAST turn's native tool_calls, followed by tool_results for EVERY turn's
 * calls — the unmatched results were silently dropped at the API boundary and
 * the model lost its own prior work.
 */
// Mock dependencies before importing chatStore — chatStore wires them on module load
jest.mock('../../services/agent/sessionService', () => ({
  sessionService: {
    setSessionGetter: jest.fn(),
    setTokenUsageGetter: jest.fn(),
    setTurnSnapshotGetter: jest.fn(),
    markDirty: jest.fn(),
    flushNow: jest.fn().mockResolvedValue(undefined),
    init: jest.fn().mockResolvedValue(undefined),
    startAutoSave: jest.fn(),
    stopAutoSave: jest.fn(),
    saveSession: jest.fn().mockResolvedValue(undefined),
    loadSession: jest.fn().mockResolvedValue(null),
    getActiveSessionId: jest.fn().mockResolvedValue(null),
    setActiveSessionId: jest.fn().mockResolvedValue(undefined),
    listSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn(),
    cleanupEmptySessions: jest.fn().mockResolvedValue(undefined),
  },
  captureByokSnapshot: jest.fn(() => null),
}))

jest.mock('../../services/agent/diffService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      registerDiff: jest.fn(),
      acceptDiff: jest.fn(),
      rejectDiff: jest.fn(),
    }),
  },
  DiffResult: {},
}))

jest.mock('../../utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

import { rebuildConversationHistory } from '../chatStore'
import type { ChatMessage, ProviderState } from '../../types/chat'

const ts = 1718000000000

function nativeTurn(
  text: string,
  toolCalls: Array<{ id: string; name: string }>,
): ProviderState {
  return {
    provider: 'test',
    protocol: 'openai-chat',
    nativeAssistantMessage: {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map(c => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: '{}' },
            })),
          }
        : {}),
    },
  }
}

function toolCall(id: string, result?: string, status: 'running' | 'completed' = 'completed') {
  return { id, toolName: 'read_file', input: {}, result, status, timestamp: ts }
}

function userMsg(content: string): ChatMessage {
  return { id: 'u1', role: 'user', content, timestamp: ts }
}

describe('rebuildConversationHistory — per-turn providerStates', () => {
  it('emits one assistant + tool_results pair PER internal turn, in order', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'turn1 text\nturn2 text\nfinal text',
      timestamp: ts,
      toolCalls: [toolCall('id1', 'r1'), toolCall('id2', 'r2'), toolCall('id3', 'r3')],
      providerStates: [
        nativeTurn('turn1 text', [{ id: 'id1', name: 'read_file' }, { id: 'id2', name: 'read_file' }]),
        nativeTurn('turn2 text', [{ id: 'id3', name: 'read_file' }]),
        nativeTurn('final text', []),
      ],
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])

    // user, assistant(t1), results(id1,id2), assistant(t2), results(id3), assistant(final)
    expect(history.map(m => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ])

    const t1 = history[1] as { _native?: { tool_calls?: Array<{ id: string }> } }
    expect(t1._native?.tool_calls?.map(c => c.id)).toEqual(['id1', 'id2'])

    const r1 = history[2].content as Array<{ type: string; toolCallId: string; content: string }>
    expect(r1.map(b => b.toolCallId)).toEqual(['id1', 'id2'])
    expect(r1[0].content).toBe('r1')

    const r2 = history[4].content as Array<{ toolCallId: string; content: string }>
    expect(r2).toHaveLength(1)
    expect(r2[0].toolCallId).toBe('id3')

    const final = history[5] as { _native?: { content?: string } }
    expect(final._native?.content).toBe('final text')
  })

  it('every emitted tool_result id is advertised by the immediately preceding assistant turn', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'x',
      timestamp: ts,
      toolCalls: [toolCall('id1', 'r1'), toolCall('id2', 'r2')],
      providerStates: [
        nativeTurn('t1', [{ id: 'id1', name: 'read_file' }]),
        nativeTurn('t2', [{ id: 'id2', name: 'read_file' }]),
      ],
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])

    for (let i = 0; i < history.length; i++) {
      const msg = history[i]
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      const resultIds = (msg.content as Array<{ type?: string; toolCallId?: string }>)
        .filter(b => b.type === 'tool_result')
        .map(b => b.toolCallId)
      if (resultIds.length === 0) continue
      const prev = history[i - 1] as { _native?: { tool_calls?: Array<{ id: string }> } }
      const advertised = prev._native?.tool_calls?.map(c => c.id) ?? []
      for (const id of resultIds) expect(advertised).toContain(id)
    }
  })

  it('drops tool calls never committed in any native turn (aborted loop) instead of fabricating orphan results', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'x',
      timestamp: ts,
      // id2 was collected by the UI but its turn never reached message_stop
      toolCalls: [toolCall('id1', 'r1'), toolCall('id2', undefined, 'running')],
      providerStates: [nativeTurn('t1', [{ id: 'id1', name: 'read_file' }])],
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])

    const allResultIds = history
      .filter(m => Array.isArray(m.content))
      .flatMap(m => (m.content as Array<{ type?: string; toolCallId?: string }>)
        .filter(b => b.type === 'tool_result')
        .map(b => b.toolCallId))
    expect(allResultIds).toEqual(['id1'])
  })

  it('marks a call advertised by a native turn but missing a result as interrupted', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'x',
      timestamp: ts,
      toolCalls: [toolCall('id1', undefined, 'running')],
      providerStates: [nativeTurn('t1', [{ id: 'id1', name: 'read_file' }])],
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])
    const results = history[2].content as Array<{ toolCallId: string; content: string }>
    expect(results[0].content).toBe('Tool call was interrupted.')
  })

  it('legacy single providerState path is unchanged (old persisted sessions)', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'legacy',
      timestamp: ts,
      toolCalls: [toolCall('id1', 'r1'), toolCall('id2', 'r2')],
      // Only the old singular field — pre-providerStates session
      providerState: nativeTurn('legacy', [{ id: 'id2', name: 'read_file' }]),
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])

    // Old behavior preserved: one assistant + one user with results for ALL calls
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    const results = history[2].content as Array<{ toolCallId: string }>
    expect(results.map(r => r.toolCallId)).toEqual(['id1', 'id2'])
  })
})
