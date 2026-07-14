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

describe('rebuildConversationHistory — @-mention staleness reconciliation', () => {
  function userWithMention(content: string, ctx: string, mentionedPaths: string[]): ChatMessage {
    return { id: 'u1', role: 'user', content, timestamp: ts, mentionContext: ctx, mentionedPaths }
  }

  function assistantReading(path: string): ChatMessage {
    return {
      id: 'a1',
      role: 'assistant',
      content: 'ok',
      timestamp: ts,
      toolCalls: [{ id: 't1', toolName: 'edit_file', input: { file_path: path }, result: 'done', status: 'completed', timestamp: ts }],
      providerStates: [nativeTurn('ok', [{ id: 't1', name: 'edit_file' }])],
    }
  }

  const SNAPSHOT = '<system-reminder>Result of calling the read_file tool:\nOLD CONTENT</system-reminder>'

  function lastUserText(history: ReturnType<typeof rebuildConversationHistory>): string {
    const userMsgs = history.filter(m => m.role === 'user')
    const first = userMsgs[0]
    return typeof first.content === 'string'
      ? first.content
      : (first.content as Array<{ type: string; text?: string }>).map(p => p.text ?? '').join('')
  }

  it('voids the snapshot when the only mentioned file was later edited', () => {
    const history = rebuildConversationHistory([
      userWithMention('look at @/abs/config.ts', SNAPSHOT, ['/abs/config.ts']),
      assistantReading('/abs/config.ts'),
    ])
    const text = lastUserText(history)
    expect(text).not.toContain('OLD CONTENT')
    expect(text).toContain('via @-mention')
    expect(text).toContain('/abs/config.ts')
  })

  it('keeps the full snapshot in rebuilt history when the file was not later touched', () => {
    const history = rebuildConversationHistory([
      userWithMention('look at @/abs/config.ts', SNAPSHOT, ['/abs/config.ts']),
      { id: 'a1', role: 'assistant', content: 'just talking', timestamp: ts },
    ])
    const text = lastUserText(history)
    // Provider payload compaction happens later in query.ts, against the final
    // in-memory request. Rebuilt persisted history keeps the source body.
    expect(text).toContain('OLD CONTENT')
    expect(text).toContain('/abs/config.ts')
  })

  it('keeps the full snapshot on the FIRST turn (no following content)', () => {
    const history = rebuildConversationHistory([
      userWithMention('look at @/abs/config.ts', SNAPSHOT, ['/abs/config.ts']),
    ])
    // First turn → the model has never seen the outline; emit it in full.
    expect(lastUserText(history)).toContain('OLD CONTENT')
  })

  it('matches abs mentioned path against a relative tool-call path', () => {
    const history = rebuildConversationHistory([
      userWithMention('@/Users/x/proj/src/config.ts', SNAPSHOT, ['/Users/x/proj/src/config.ts']),
      assistantReading('src/config.ts'),
    ])
    expect(lastUserText(history)).not.toContain('OLD CONTENT')
  })

  it('prepends a targeted warning but keeps the block when only some files were superseded', () => {
    const twoFiles = `${SNAPSHOT}\n<system-reminder>Result of calling the read_file tool:\nUNTOUCHED</system-reminder>`
    const history = rebuildConversationHistory([
      userWithMention('@/abs/a.ts @/abs/b.ts', twoFiles, ['/abs/a.ts', '/abs/b.ts']),
      assistantReading('/abs/a.ts'),
    ])
    const text = lastUserText(history)
    expect(text).toContain('STALE for /abs/a.ts')
    expect(text).toContain('UNTOUCHED') // the still-fresh sibling survives
  })

  it('emits verbatim when mentionedPaths is absent (old session)', () => {
    const history = rebuildConversationHistory([
      { id: 'u1', role: 'user', content: 'q', timestamp: ts, mentionContext: SNAPSHOT },
      assistantReading('/abs/config.ts'),
    ])
    expect(lastUserText(history)).toContain('OLD CONTENT')
  })

  it('does not void when the tool touch is in an EARLIER message (only later supersedes)', () => {
    const history = rebuildConversationHistory([
      assistantReading('/abs/config.ts'),
      userWithMention('now @/abs/config.ts', SNAPSHOT, ['/abs/config.ts']),
    ])
    // The mention came AFTER the edit → its snapshot is the freshest, keep it.
    const userMsgs = history.filter(m => m.role === 'user')
    const mentionMsg = userMsgs[userMsgs.length - 1]
    const text = typeof mentionMsg.content === 'string'
      ? mentionMsg.content
      : (mentionMsg.content as Array<{ text?: string }>).map(p => p.text ?? '').join('')
    expect(text).toContain('OLD CONTENT')
  })
})

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
    // Actionable interruption marker: still flags the interruption, and now
    // steers the model to resume (not re-explore from scratch).
    expect(results[0].content).toContain('interrupted')
    expect(results[0].content).toContain('do not re-explore the project from scratch')
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

describe('rebuildConversationHistory — compact_boundary summary re-emission', () => {
  const boundary = (compactSummary?: string): ChatMessage => ({
    id: 'b1',
    role: 'system',
    kind: 'compact_boundary',
    content: 'Conversa comprimida (50K tokens).',
    timestamp: ts,
    ...(compactSummary ? { compactSummary } : {}),
  })

  it('re-emits the boundary summary as a user message so the model retains it', () => {
    // Post-compaction shape: the boundary leads the trimmed history. Without
    // re-emission the model would receive only "continue please" with no idea
    // what it's continuing.
    const history = rebuildConversationHistory([
      boundary('SUMMARY OF PRIOR WORK'),
      userMsg('continue please'),
    ])
    expect(history.map(m => m.role)).toEqual(['user', 'user'])
    expect(history[0].content).toBe('SUMMARY OF PRIOR WORK')
    expect(history[1].content).toBe('continue please')
  })

  it('still skips a boundary that carries NO summary (UI-only marker)', () => {
    const history = rebuildConversationHistory([
      boundary(),
      userMsg('hi'),
    ])
    expect(history.map(m => m.role)).toEqual(['user'])
    expect(history[0].content).toBe('hi')
  })
})

describe('rebuildConversationHistory — UI-only assistant text', () => {
  it('keeps app-generated progress out of legacy assistant reconstruction', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'Preparing project context...\n\nFinal answer',
      timestamp: ts,
      contentBlocks: [
        { type: 'text', text: 'Preparing project context...\n\n', uiOnly: true },
        { type: 'text', text: 'Final answer' },
      ],
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])

    expect(history[1].content).toEqual([{ type: 'text', text: 'Final answer' }])
  })

  it('omits pure UI progress while preserving legacy tool calls/results', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'Preparing project context...\n\n',
      timestamp: ts,
      contentBlocks: [
        { type: 'text', text: 'Preparing project context...\n\n', uiOnly: true },
      ],
      toolCalls: [toolCall('id1', 'r1')],
    }

    const history = rebuildConversationHistory([userMsg('hi'), assistant])
    const assistantBlocks = history[1].content as Array<{ type: string; text?: string; id?: string }>
    const resultBlocks = history[2].content as Array<{ type: string; toolCallId: string; content: string }>

    expect(assistantBlocks).toEqual([
      { type: 'tool_call', id: 'id1', name: 'read_file', arguments: '{}' },
    ])
    expect(resultBlocks).toEqual([
      { type: 'tool_result', toolCallId: 'id1', content: 'r1' },
    ])
  })
})
