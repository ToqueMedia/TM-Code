import { parseMcpToolResult } from '../mcpService'

describe('parseMcpToolResult', () => {
  it('extracts text blocks', () => {
    const r = parseMcpToolResult({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    })
    expect(r.text).toBe('line 1\nline 2')
    expect(r.images).toEqual([])
  })

  it('extracts image blocks with mimeType + base64 data', () => {
    const r = parseMcpToolResult({
      content: [
        { type: 'text', text: 'Took viewport screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'abc123' },
      ],
    })
    expect(r.text).toBe('Took viewport screenshot')
    expect(r.images).toEqual([{ mimeType: 'image/png', data: 'abc123' }])
  })

  it('defaults mimeType when missing', () => {
    const r = parseMcpToolResult({
      content: [{ type: 'image', data: 'xyz' }],
    })
    expect(r.images).toEqual([{ mimeType: 'image/png', data: 'xyz' }])
  })

  it('stringifies non-content results', () => {
    const r = parseMcpToolResult({ ok: true })
    expect(r.text).toContain('ok')
    expect(r.images).toEqual([])
  })
})
