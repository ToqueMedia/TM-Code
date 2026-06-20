// Pure signaling protocol helpers — no I/O, no globals. Isolated here so the
// routing + handshake logic is unit-testable without a live WebSocket.

import {
  COLLAB_SUBPROTOCOL,
  type AddressedMessage,
  type SignalType,
} from './types'

const SIGNAL_TYPES: ReadonlySet<string> = new Set<SignalType>(['offer', 'answer', 'ice'])

/**
 * Extract the bearer token the client tucked into the WebSocket subprotocol.
 *
 * The IDE connects with `new WebSocket(url, [COLLAB_SUBPROTOCOL, idToken])`, so
 * the `Sec-WebSocket-Protocol` request header arrives as
 * `"tm.collab.v1, <jwt>"`. Returns the token, or null if the protocol marker
 * is absent/malformed.
 */
export function tokenFromSubprotocols(header: string | null): string | null {
  if (!header) return null
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2 || parts[0] !== COLLAB_SUBPROTOCOL) return null
  return parts[1] || null
}

/**
 * Validate an inbound client→server envelope: a WebRTC signal (offer/answer/ice)
 * OR a `relay` data message (P2P fallback). Returns it typed, or null. Both are
 * addressed point-to-point via `to`.
 */
export function parseInbound(raw: unknown): AddressedMessage | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const msg = value as Record<string, unknown>
  if (typeof msg.to !== 'string' || msg.to.length === 0) return null

  if (typeof msg.type === 'string' && SIGNAL_TYPES.has(msg.type)) {
    return { type: msg.type as SignalType, to: msg.to, payload: msg.payload }
  }
  if (
    msg.type === 'relay' &&
    (msg.channel === 'control' || msg.channel === 'bulk') &&
    typeof msg.payload === 'string'
  ) {
    return { type: 'relay', to: msg.to, channel: msg.channel, payload: msg.payload }
  }
  return null
}

/**
 * Resolve which peers an envelope should be delivered to. Addressed messages are
 * point-to-point (`to` set), so this returns at most one peer — but never the
 * sender, and never a peer that isn't currently present.
 */
export function routeTargets(
  msg: { to: string },
  presentPeerIds: readonly string[],
  senderId: string,
): string[] {
  return presentPeerIds.filter((id) => id !== senderId && id === msg.to)
}
