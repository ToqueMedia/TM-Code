import { buildGoalFrames, GOAL_FRAME_INTERVAL_MS } from '../goalFrames'

describe('buildGoalFrames', () => {
  it('produces a non-trivial ordered frame list', () => {
    const frames = buildGoalFrames()
    expect(frames.length).toBeGreaterThan(20)
    expect(frames.every((f) => typeof f === 'string')).toBe(true)
  })

  it('starts with the ball at the left edge and rolls rightward', () => {
    const frames = buildGoalFrames()
    // Frame 0: a spinning ball glyph sits at column 0.
    expect(frames[0][0]).toMatch(/[◐◓◑◒]/u)
    // A few frames in, the ball has advanced — leading spaces precede it.
    expect(frames[5].startsWith('     ')).toBe(true)
    expect(frames[5].trimStart()[0]).toMatch(/[◐◓◑◒]/u)
  })

  it('ends on a celebratory frame: spaced word + flashing net', () => {
    const frames = buildGoalFrames('GOAL!')
    const last = frames[frames.length - 1]
    expect(last).toContain('G O A L !')
    expect(last).toMatch(/╢[▓█▒]╟/u)
  })

  it('localises the word and strips trailing punctuation', () => {
    const frames = buildGoalFrames('GOOOLO!')
    expect(frames.some((f) => f.includes('G O O O L O !'))).toBe(true)
    // The raw "!" is normalised away (re-added spaced), never doubled.
    expect(frames.some((f) => f.includes('!!'))).toBe(false)
  })

  it('exposes a positive discrete step cadence', () => {
    expect(GOAL_FRAME_INTERVAL_MS).toBeGreaterThan(0)
  })
})
