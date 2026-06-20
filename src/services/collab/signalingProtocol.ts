// Client-side mirror of the collab-signaling worker's wire protocol, plus pure
// helpers shared by the signaling client and the WebRTC mesh. Kept dependency-
// free so the URL/initiator logic is unit-testable without a real socket.

/** Subprotocol marker — MUST match the worker's COLLAB_SUBPROTOCOL. */
export const COLLAB_SUBPROTOCOL = 'tm.collab.v1'

export type SignalType = 'offer' | 'answer' | 'ice'

export interface PeerInfo {
  peerId: string
  uid: string
  name: string
}

/** Logical data channels that can be relayed through the DO when P2P fails. */
export type RelayChannel = 'control' | 'bulk'

/** Messages the worker pushes to the client. */
export type ServerMessage =
  | { type: 'welcome'; selfId: string; peers: PeerInfo[] }
  | { type: 'peer-join'; peer: PeerInfo }
  | { type: 'peer-leave'; peerId: string }
  | { type: SignalType; from: string; payload: unknown }
  | { type: 'relay'; from: string; channel: RelayChannel; payload: string }

/** Client → worker: forward a WebRTC signal to one peer. */
export interface SignalMessage {
  type: SignalType
  to: string
  payload: unknown
}

/** Client → worker: relay channel data to a peer (P2P fallback). */
export interface RelayMessage {
  type: 'relay'
  to: string
  channel: RelayChannel
  payload: string
}

/**
 * Build the signaling WebSocket URL. The base is a `ws://`/`wss://` origin; we
 * append the room path and the display name as a query param. The auth token
 * is NOT placed in the URL — it travels in the WebSocket subprotocol (see
 * `signalingSubprotocols`) so it never lands in server/proxy access logs.
 */
export function buildSignalingUrl(base: string, teamId: string, name: string): string {
  const trimmed = base.replace(/\/+$/, '')
  const query = name ? `?name=${encodeURIComponent(name)}` : ''
  return `${trimmed}/v1/collab/${encodeURIComponent(teamId)}${query}`
}

/** The subprotocol array to pass to `new WebSocket(url, ...)`. */
export function signalingSubprotocols(idToken: string): string[] {
  return [COLLAB_SUBPROTOCOL, idToken]
}

/**
 * Deterministic initiator selection to avoid WebRTC "glare" (both peers
 * offering at once). The peer with the lexicographically smaller id creates the
 * offer + DataChannels; the other answers. Both sides compute the same answer.
 */
export function shouldInitiate(selfId: string, peerId: string): boolean {
  return selfId < peerId
}

/** Parse a raw socket message into a typed ServerMessage, or null if invalid. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const msg = value as { type?: unknown }
  if (typeof msg.type !== 'string') return null
  return value as ServerMessage
}
