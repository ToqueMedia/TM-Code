import { countDiffLineStats } from '../diffStats'

describe('countDiffLineStats', () => {
  it('counts added and removed lines in a unified edit', () => {
    const oldC = 'a\nb\nc\n'
    const newC = 'a\nB\nc\n'
    expect(countDiffLineStats(oldC, newC)).toEqual({ added: 1, removed: 1 })
  })

  it('counts a new file as only additions', () => {
    expect(countDiffLineStats('', 'one\ntwo\n', true)).toEqual({ added: 2, removed: 0 })
  })

  it('returns zeros for identical content', () => {
    expect(countDiffLineStats('same\n', 'same\n')).toEqual({ added: 0, removed: 0 })
  })
})
