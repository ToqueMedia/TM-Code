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

/** Messages the worker pushes to the client. On welcome, `iceServers` are
 *  ephemeral TURN credentials (present when the worker has a Calls TURN key)
 *  and `mediaPolicy` the per-plan voice/screen limits. */
export type ServerMessage =
  | { type: 'welcome'; selfId: string; peers: PeerInfo[]; iceServers?: unknown; mediaPolicy?: unknown }
  | { type: 'peer-join'; peer: PeerInfo }
  | { type: 'peer-leave'; peerId: string }
  | { type: SignalType; from: string; payload: unknown }
  | { type: 'relay'; from: string; channel: RelayChannel; payload: string }

/**
 * Per-plan voice/screen limits the worker hands out on welcome. Absent (old
 * worker) → null → the client applies NO limits, so a worker rollback can
 * never lock paying teams out of calls.
 */
export interface MediaPolicy {
  maxCallParticipants: number
  /** Minutes; null = unlimited. */
  maxCallMinutes: number | null
  maxScreenWatchers: number
  screenMaxHeight: number
  screenMaxFrameRate: number
  /** Encoder ceiling per watcher (kbps). Optional on the wire — workers
   *  deployed before the field existed send 5-field policies. */
  screenMaxBitrateKbps: number
}

/** Default encoder ceiling when the policy predates the bitrate field. */
const DEFAULT_SCREEN_BITRATE_KBPS = 4000

/** Validate the welcome's `mediaPolicy` blob (version-skewed wire — never
 *  trust the shape). Null on anything malformed. */
export function sanitizeMediaPolicy(value: unknown): MediaPolicy | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const posInt = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) && x >= 1 ? Math.floor(x) : null
  const maxCallParticipants = posInt(v.maxCallParticipants)
  const maxScreenWatchers = posInt(v.maxScreenWatchers)
  const screenMaxHeight = posInt(v.screenMaxHeight)
  const screenMaxFrameRate = posInt(v.screenMaxFrameRate)
  if (
    maxCallParticipants === null ||
    maxScreenWatchers === null ||
    screenMaxHeight === null ||
    screenMaxFrameRate === null
  ) {
    return null
  }
  // `null` is the only spelling of "unlimited" — an INVALID number (negative,
  // NaN, string) must reject the whole policy, never upgrade to unlimited.
  let maxCallMinutes: number | null
  if (v.maxCallMinutes === null) {
    maxCallMinutes = null
  } else {
    const parsed = posInt(v.maxCallMinutes)
    if (parsed === null) return null
    maxCallMinutes = parsed
  }
  // Absent (pre-bitrate worker) → default; present-but-invalid → reject.
  let screenMaxBitrateKbps = DEFAULT_SCREEN_BITRATE_KBPS
  if (v.screenMaxBitrateKbps !== undefined) {
    const parsed = posInt(v.screenMaxBitrateKbps)
    if (parsed === null) return null
    screenMaxBitrateKbps = parsed
  }
  return {
    maxCallParticipants,
    maxCallMinutes,
    maxScreenWatchers,
    screenMaxHeight,
    screenMaxFrameRate,
    screenMaxBitrateKbps,
  }
}

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

/**
 * Validate the welcome's `iceServers` blob into a clean RTCIceServer list (or
 * null). Defensive on purpose: the field crosses a version-skewed wire, and a
 * malformed entry passed to RTCPeerConnection() throws — which would kill the
 * whole mesh, not just TURN.
 */
export function sanitizeIceServers(value: unknown): RTCIceServer[] | null {
  if (!Array.isArray(value)) return null
  const out: RTCIceServer[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const urls = Array.isArray(e.urls)
      ? e.urls.filter((u): u is string => typeof u === 'string')
      : typeof e.urls === 'string'
        ? [e.urls]
        : []
    if (urls.length === 0) continue
    const server: RTCIceServer = { urls }
    if (typeof e.username === 'string') server.username = e.username
    if (typeof e.credential === 'string') server.credential = e.credential
    out.push(server)
  }
  return out.length > 0 ? out : null
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
