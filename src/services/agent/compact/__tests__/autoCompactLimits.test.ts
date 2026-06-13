/**
 * Regression tests for the real-window auto-compact decision (context
 * pollution audit, 2026-06-12). Before this, shouldAutoCompact hardcoded a 1M
 * window and a char-estimate, so a small-window model could overflow without
 * ever compacting. Now it tracks the active model's real window and the
 * provider's real token occupancy.
 */
import { shouldAutoCompact, type AutoCompactLimits } from '../autoCompact'
import { getAutoCompactThreshold } from '../../../../utils/contextWindow'

// A message whose char-estimate is ~`tokens` (roughTokenEstimate = chars/4*4/3,
// so chars ≈ tokens * 3 yields ≈ tokens).
function msgOfTokens(tokens: number) {
  return { role: 'user' as const, content: 'x'.repeat(tokens * 3) }
}

describe('shouldAutoCompact — real window limits', () => {
  it('fires well before overflow on a small (200K) window that the legacy 1M path would miss', () => {
    // 180K tokens of history (real threshold for a 200K window ≈ 170.6K).
    // Legacy path (1M window, ~967K threshold) would NOT compact. With a real
    // 200K window it must.
    const messages = [msgOfTokens(180_000)]
    const limits: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }

    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
    // Sanity: the legacy (no-limits) call would NOT fire at 180K.
    expect(shouldAutoCompact(messages, 0)).toBe(false)
  })

  it('does not fire when occupancy is comfortably under the real threshold', () => {
    const messages = [msgOfTokens(50_000)]
    const limits: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(false)
  })

  it('uses the provider real occupancy when it exceeds the char-estimate (catches tool_call args the estimate misses)', () => {
    // Tiny text estimate, but the provider counted 190K real tokens.
    const messages = [msgOfTokens(1_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      realOccupancyTokens: 190_000,
    }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
  })

  it('uses the char-estimate when it exceeds the real occupancy (tool results appended since last turn)', () => {
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    const messages = [msgOfTokens(threshold + 5_000)]
    const limits: AutoCompactLimits = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      // last turn's real reading was small; estimate must still win
      realOccupancyTokens: 10_000,
    }
    expect(shouldAutoCompact(messages, 0, limits)).toBe(true)
  })

  it('subtracts snip-freed tokens from the estimate', () => {
    const threshold = getAutoCompactThreshold(200_000, 16_384)
    const messages = [msgOfTokens(threshold + 5_000)]
    const limits: AutoCompactLimits = { contextWindow: 200_000, maxOutputTokens: 16_384 }
    // Freeing 20K drops the estimate below threshold.
    expect(shouldAutoCompact(messages, 20_000, limits)).toBe(false)
  })

  it('falls back to the legacy 1M estimate path when the window is unknown (null)', () => {
    const messages = [msgOfTokens(170_000)]
    const limits: AutoCompactLimits = { contextWindow: null, maxOutputTokens: null }
    // 170K is far below the legacy ~967K threshold → no compaction.
    expect(shouldAutoCompact(messages, 0, limits)).toBe(false)
  })

  it('threshold respects the real window: a 1M model tolerates far more than a 200K one', () => {
    const messages = [msgOfTokens(300_000)]
    expect(shouldAutoCompact(messages, 0, { contextWindow: 200_000, maxOutputTokens: 16_384 })).toBe(true)
    expect(shouldAutoCompact(messages, 0, { contextWindow: 1_000_000, maxOutputTokens: 65_536 })).toBe(false)
  })
})
