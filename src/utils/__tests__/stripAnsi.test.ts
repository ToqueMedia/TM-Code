import { normalizeTerminalText, stripAnsi } from '../stripAnsi'

describe('stripAnsi', () => {
  it('strips 256-color SGR (the exact UI garbage pattern)', () => {
    const raw = '\x1b[38;5;246mhello\x1b[0m \x1b[38;5;249mworld\x1b[0m'
    expect(stripAnsi(raw)).toBe('hello world')
  })

  it('strips orphan SGR tails when ESC is missing', () => {
    // What the user saw: ESC already gone, only [38;5;Nm remains
    const raw = '[38;5;246m[0m[38;5;249mfoo[0m'
    expect(stripAnsi(raw)).toBe('foo')
  })

  it('does not strip legitimate bracket tags like [error]', () => {
    expect(stripAnsi('[error] boom')).toBe('[error] boom')
    expect(stripAnsi('[ok] done')).toBe('[ok] done')
  })

  it('strips truecolor and simple colors', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[38;2;255;0;0mrgb\x1b[0m')).toBe('rgb')
  })

  it('normalizeTerminalText applies backspaces and normalizes newlines', () => {
    expect(normalizeTerminalText('ab\bc')).toBe('ac')
    expect(normalizeTerminalText('a\r\nb')).toBe('a\nb')
  })
})

