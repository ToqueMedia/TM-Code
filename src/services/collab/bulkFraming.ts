// Generic chunked-message framing for the WebRTC `bulk` channel (and its DO
// relay fallback). A DataChannel message has a practical ~256KB ceiling and the
// relay WebSocket has its own limit, so any large payload (an HTTP body, a JS
// bundle) is split into fixed-size frames tagged with a transfer id + a `kind`
// discriminator, and reassembled on the far side. Pure + dependency-free.

/** Conservative chunk size (chars) — well under the channel ceiling. */
export const BULK_CHUNK_SIZE = 48 * 1024

interface BulkFrame {
  /** Marker so non-framed messages are ignored. */
  t: 'bf'
  /** Transfer id (groups frames of one message). */
  id: string
  /** Message discriminator (e.g. 'tunnel-req', 'tunnel-res'). */
  kind: string
  seq: number
  total: number
  data: string
}

/** Split a string payload into ordered frames ready for `sendBulk`. */
export function encodeBulk(
  kind: string,
  id: string,
  payload: string,
  chunkSize: number = BULK_CHUNK_SIZE,
): string[] {
  const total = Math.max(1, Math.ceil(payload.length / chunkSize))
  const frames: string[] = []
  for (let seq = 0; seq < total; seq += 1) {
    const frame: BulkFrame = {
      t: 'bf',
      id,
      kind,
      seq,
      total,
      data: payload.slice(seq * chunkSize, (seq + 1) * chunkSize),
    }
    frames.push(JSON.stringify(frame))
  }
  return frames
}

function parseFrame(raw: string): BulkFrame | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const f = value as Record<string, unknown>
  if (
    f.t !== 'bf' ||
    typeof f.id !== 'string' ||
    typeof f.kind !== 'string' ||
    typeof f.seq !== 'number' ||
    typeof f.total !== 'number' ||
    typeof f.data !== 'string'
  ) {
    return null
  }
  return { t: 'bf', id: f.id, kind: f.kind, seq: f.seq, total: f.total, data: f.data }
}

export interface BulkComplete {
  kind: string
  id: string
  payload: string
}

/**
 * Reassembles framed bulk messages. Tolerates out-of-order / duplicate frames;
 * returns `{ kind, id, payload }` once a transfer is complete, else null. A
 * malformed frame is ignored without poisoning other in-flight transfers.
 */
export class BulkReassembler {
  private readonly transfers = new Map<string, { kind: string; total: number; parts: Map<number, string> }>()

  accept(raw: string): BulkComplete | null {
    const frame = parseFrame(raw)
    if (!frame) return null

    let entry = this.transfers.get(frame.id)
    if (!entry) {
      entry = { kind: frame.kind, total: frame.total, parts: new Map() }
      this.transfers.set(frame.id, entry)
    }
    entry.parts.set(frame.seq, frame.data)
    if (entry.parts.size < entry.total) return null

    let payload = ''
    for (let seq = 0; seq < entry.total; seq += 1) {
      const part = entry.parts.get(seq)
      if (part === undefined) return null // gap — wait for more
      payload += part
    }
    this.transfers.delete(frame.id)
    return { kind: entry.kind, id: frame.id, payload }
  }

  /** Forget an in-flight transfer (e.g. when a peer disconnects). */
  drop(id: string): void {
    this.transfers.delete(id)
  }
}
