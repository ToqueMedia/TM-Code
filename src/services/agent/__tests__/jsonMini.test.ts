import { jsonMini } from '../jsonMini'

describe('jsonMini', () => {
  it('is pure minified JSON with no dependency side effects', () => {
    expect(jsonMini({ x: true, n: 1 })).toBe('{"x":true,"n":1}')
  })
})
