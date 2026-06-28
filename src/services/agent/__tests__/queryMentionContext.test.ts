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
    expect(stats.mentionContextRefId).toBe('mc-0')
  })
})
