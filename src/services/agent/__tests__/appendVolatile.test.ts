import { appendVolatileReminder } from '../volatileAppend'

describe('appendVolatileReminder (multimodal-safe)', () => {
  it('appends reminder to a plain string', () => {
    const out = appendVolatileReminder('hello user', 'volatile-snapshot-xyz')
    expect(typeof out).toBe('string')
    expect(out as string).toContain('hello user')
    expect(out as string).toContain('system-reminder')
    expect(out as string).toContain('volatile-snapshot-xyz')
  })

  it('appends a trailing text block to multimodal content arrays', () => {
    const input = [
      { type: 'text' as const, text: 'look' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA' } },
    ]
    const out = appendVolatileReminder(input, 'volatile-snapshot-xyz')
    expect(Array.isArray(out)).toBe(true)
    const arr = out as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(arr[0]).toEqual({ type: 'text', text: 'look' })
    expect(arr[1]?.type).toBe('image_url')
    expect(arr[arr.length - 1]?.type).toBe('text')
    expect(arr[arr.length - 1]?.text).toContain('volatile-snapshot-xyz')
    expect(arr.some(p => p.type === 'image_url')).toBe(true)
  })

  it('returns content unchanged when volatile is empty', () => {
    expect(appendVolatileReminder('x', null)).toBe('x')
    expect(appendVolatileReminder('x', '')).toBe('x')
  })
})
