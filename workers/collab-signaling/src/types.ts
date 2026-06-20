// Env + wire types for the collab signaling worker.

export interface Env {
  /** Durable Object namespace — one instance per team (idFromName = teamId). */
  SIGNALING_ROOM: DurableObjectNamespace

  /** Firebase project id (same as the data-plane). */
  FIREBASE_PROJECT_ID?: string
  /** Optional issuer / JWKS overrides (default to Google's securetoken). */
  FIREBASE_ISSUER?: string
  FIREBASE_JWKS_URL?: string

  /** Auth routing: 'firebase_emulator' | 'test_static' | default (firebase_jwt). */
  AUTH_MODE?: string
  /** Static token accepted in test_static mode. */
  TEST_USER_TOKEN?: string

  /** Firestore REST base override (set to the emulator host for local runs). */
  FIRESTORE_REST_BASE?: string

  /**
   * Control-plane base URL (e.g. https://api-agents.toquemedia.net). In
   * production the membership gate POSTs `/v1/collab/membership` here because
   * the Worker can't read Firestore directly (App Check enforcement). Unused on
   * the emulator path (FIRESTORE_REST_BASE set).
   */
  CONTROL_PLANE_URL?: string
}

export interface AuthenticatedUser {
  userId: string
}

/** The WebSocket subprotocol the IDE client speaks. */
export const COLLAB_SUBPROTOCOL = 'tm.collab.v1'

// ── Signaling envelope ─────────────────────────────────────────────────────
//
// The DO routes envelopes between peers and tracks presence. It never inspects
// or persists `payload`. Normally that's just WebRTC setup (SDP/ICE) and the
// real data (chat + live-preview tunnel) flows P2P over the DataChannels. BUT when a P2P
// connection can't be established (symmetric NAT, mDNS-across-a-VM, etc.), the
// client falls back to `relay` messages — the DO forwards control/bulk data
// between the two peers over the WebSocket. The DO still never reads the
// payload; it's just a transport of last resort so collaboration works on
// hostile networks. (DTLS-level E2E encryption is lost on the relay path — the
// trade-off for it working at all when direct P2P fails.)

export type SignalType = 'offer' | 'answer' | 'ice'

/** Client → server: forward a WebRTC signal to a specific peer. */
export interface SignalMessage {
  type: SignalType
  /** Target peer id (required — signals are always point-to-point). */
  to: string
  /** Opaque SDP/ICE blob; the server never reads it. */
  payload: unknown
}

/** Client → server: relay opaque channel data to a peer (P2P fallback). */
export interface RelayMessage {
  type: 'relay'
  to: string
  /** Which logical channel this stands in for: 'control' or 'bulk'. */
  channel: 'control' | 'bulk'
  /** Opaque serialized payload (the same string a DataChannel would carry). */
  payload: string
}

/** Any message a peer can address to another (forwarded by the DO). */
export type AddressedMessage = SignalMessage | RelayMessage

/** Server → client: presence + relayed signals/data. */
export type ServerMessage =
  | { type: 'welcome'; selfId: string; peers: PeerInfo[] }
  | { type: 'peer-join'; peer: PeerInfo }
  | { type: 'peer-leave'; peerId: string }
  | { type: SignalType; from: string; payload: unknown }
  | { type: 'relay'; from: string; channel: 'control' | 'bulk'; payload: string }

export interface PeerInfo {
  peerId: string
  uid: string
  name: string
}
