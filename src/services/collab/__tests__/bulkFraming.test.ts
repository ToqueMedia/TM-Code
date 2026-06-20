import { BulkReassembler, BULK_CHUNK_SIZE, encodeBulk } from '../bulkFraming'

describe('bulkFraming', () => {
  it('round-trips a small payload through a single frame', () => {
    const frames = encodeBulk('tunnel-req', 'r1', '{"method":"GET"}')
    expect(frames.length).toBe(1)
    expect(new BulkReassembler().accept(frames[0])).toEqual({
      kind: 'tunnel-req',
      id: 'r1',
      payload: '{"method":"GET"}',
    })
  })

  it('splits a large payload and reassembles in order', () => {
    const payload = 'x'.repeat(BULK_CHUNK_SIZE * 3 + 7)
    const frames = encodeBulk('tunnel-res', 'r2', payload)
    expect(frames.length).toBe(4)
    const r = new BulkReassembler()
    let out = null
    for (const f of frames) out = r.accept(f) ?? out
    expect(out).toEqual({ kind: 'tunnel-res', id: 'r2', payload })
  })

  it('tolerates out-of-order + duplicate frames', () => {
    const payload = 'y'.repeat(BULK_CHUNK_SIZE * 2)
    const frames = encodeBulk('k', 'r3', payload)
    expect(frames.length).toBeGreaterThan(1)
    const r = new BulkReassembler()
    const reversed = [...frames].reverse()
    let out = r.accept(reversed[0])
    out = r.accept(reversed[0]) ?? out // duplicate
    expect(out).toBeNull()
    for (let i = 1; i < reversed.length; i += 1) out = r.accept(reversed[i]) ?? out
    expect(out).toEqual({ kind: 'k', id: 'r3', payload })
  })

  it('keeps concurrent transfers separate and ignores malformed frames', () => {
    const a = encodeBulk('k', 'A', 'a'.repeat(BULK_CHUNK_SIZE + 1))
    const b = encodeBulk('k', 'B', 'b'.repeat(BULK_CHUNK_SIZE + 1))
    const r = new BulkReassembler()
    expect(r.accept(a[0])).toBeNull()
    expect(r.accept(b[0])).toBeNull()
    expect(r.accept('not json')).toBeNull()
    expect(r.accept(JSON.stringify({ t: 'other' }))).toBeNull()
    expect(r.accept(b[1])?.id).toBe('B')
    expect(r.accept(a[1])?.id).toBe('A')
  })
})
