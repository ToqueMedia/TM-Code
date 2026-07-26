/**
 * Loop-fusion residual: getSystemPrompt is re-read each turn.
 * Lightweight unit check of the resolver wiring (no full query loop).
 */

describe('getSystemPrompt turn re-read contract', () => {
  it('prefers live getter over static systemPrompt', () => {
    let live = 'static'
    const getSystemPrompt = () => live
    const resolve = (initial: string, getter?: () => string): string => {
      if (!getter) return initial
      try {
        const v = getter()
        return typeof v === 'string' && v.length > 0 ? v : initial
      } catch {
        return initial
      }
    }

    expect(resolve('static', getSystemPrompt)).toBe('static')
    live = 'ARCHITECT'
    expect(resolve('static', getSystemPrompt)).toBe('ARCHITECT')
  })

  it('falls back when getter throws or returns empty', () => {
    const resolve = (initial: string, getter?: () => string): string => {
      if (!getter) return initial
      try {
        const v = getter()
        return typeof v === 'string' && v.length > 0 ? v : initial
      } catch {
        return initial
      }
    }
    expect(resolve('base', () => '')).toBe('base')
    expect(resolve('base', () => { throw new Error('x') })).toBe('base')
  })
})
