import { compactHistoricalMentionContextForPayload } from '../query'
import { clearMentionContextTracker, getAndResetMentionContextStats } from '../mentionContextTracker'

describe('query payload @mention compaction', () => {
  const fullMention = [
    '<system-reminder>',
    '@mention compact_reference (intentional summary — full file body was NOT inlined to save context tokens):',
    'path: /proj/src/large.ts',
    'outline:',
    '- L1: LargeThing',
    '',
    'preview (first 2 lines / 4000 chars):',
    'x'.repeat(1200),
    '</system-reminder>',
  ].join('\n')

  beforeEach(() => {
    clearMentionContextTracker()
  })

  it('keeps the full mention context on the first provider turn', () => {
    const messages = compactHistoricalMentionContextForPayload([
      { role: 'user', content: `fix this\n${fullMention}` },
    ])

    expect(messages[0].content).toContain('x'.repeat(100))
    const stats = getAndResetMentionContextStats()
    expect(stats.mentionContextSentFullThisTurn).toBe(true)
    expect(stats.mentionContextRepeatedTokens).toBe(0)
    expect(stats.mentionContextFullTokens).toBeGreaterThan(0)
    expect(stats.mentionContextStubTokens).toBe(0)
    expect(stats.mentionContextRepeatedTokensCumulative).toBe(0)
    expect(stats.mentionContextRefId).toBe('mc-0')
  })

  it('replaces historical full mention context with a compact stub', () => {
    const messages = compactHistoricalMentionContextForPayload([
      { role: 'user', content: `fix this\n${fullMention}` },
      { role: 'assistant', content: 'I will inspect it.' },
    ])

    expect(messages[0].content).toContain('@mention compact_reference already provided earlier')
    expect(messages[0].content).toContain('mentionContextRefId: mc-0')
    expect(messages[0].content).toContain('filePath: /proj/src/large.ts')
    expect(messages[0].content).not.toContain('x'.repeat(100))

    const stats = getAndResetMentionContextStats()
    expect(stats.mentionContextSentFullThisTurn).toBe(false)
    expect(stats.mentionContextRepeatedTokens).toBeGreaterThan(0)
    expect(stats.mentionContextFullTokens).toBeGreaterThan(stats.mentionContextStubTokens)
    expect(stats.mentionContextStubTokens).toBeGreaterThan(0)
    expect(stats.mentionContextRepeatedTokensCumulative).toBe(stats.mentionContextRepeatedTokens)
    expect(stats.mentionContextRefId).toBe('mc-0')
  })

  it('reports the same per-turn saving when the full internal history is compacted again', () => {
    const history = [
      { role: 'user' as const, content: `fix this\n${fullMention}` },
      { role: 'assistant' as const, content: 'turn 1' },
    ]

    compactHistoricalMentionContextForPayload(history)
    const turn2 = getAndResetMentionContextStats()
    compactHistoricalMentionContextForPayload([...history, { role: 'assistant', content: 'turn 2' }])
    const turn3 = getAndResetMentionContextStats()

    expect(turn2.mentionContextRepeatedTokens).toBeGreaterThan(0)
    expect(turn3.mentionContextRepeatedTokens).toBe(turn2.mentionContextRepeatedTokens)
    expect(turn3.mentionContextRepeatedTokensCumulative).toBe(
      turn2.mentionContextRepeatedTokens + turn3.mentionContextRepeatedTokens,
    )
  })

  it('resets cumulative repeated-token savings for a new session', () => {
    const history = [
      { role: 'user' as const, content: `fix this\n${fullMention}` },
      { role: 'assistant' as const, content: 'turn 1' },
    ]

    compactHistoricalMentionContextForPayload(history)
    const turn2 = getAndResetMentionContextStats()
    expect(turn2.mentionContextRepeatedTokensCumulative).toBeGreaterThan(0)

    clearMentionContextTracker()
    compactHistoricalMentionContextForPayload([
      { role: 'user' as const, content: `new session\n${fullMention}` },
    ])
    const newTurn1 = getAndResetMentionContextStats()

    expect(newTurn1.mentionContextSentFullThisTurn).toBe(true)
    expect(newTurn1.mentionContextRepeatedTokens).toBe(0)
    expect(newTurn1.mentionContextRepeatedTokensCumulative).toBe(0)
  })
})
