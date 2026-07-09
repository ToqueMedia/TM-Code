// Thin WebSocket wrapper over the collab-signaling worker. Handles the
// subprotocol handshake (auth token travels there, not in the URL) and decodes
// the worker's presence/signal messages into typed callbacks. It carries ONLY
// WebRTC setup + presence — never changesets or chat (those go P2P over the
// DataChannels the mesh establishes from these signals).

import {
  buildSignalingUrl,
  parseServerMessage,
  sanitizeIceServers,
  signalingSubprotocols,
  type PeerInfo,
  type RelayChannel,
  type RelayMessage,
  type SignalMessage,
  type SignalType,
} from './signalingProtocol'

export interface SignalingHandlers {
  /** `iceServers`: ephemeral TURN credentials from the worker (null when the
   *  worker has no TURN key configured → STUN-only session). */
  onWelcome: (selfId: string, peers: PeerInfo[], iceServers: RTCIceServer[] | null) => void
  onPeerJoin: (peer: PeerInfo) => void
  onPeerLeave: (peerId: string) => void
  onSignal: (from: string, type: SignalType, payload: unknown) => void
  /** Relayed channel data (P2P fallback path). */
  onRelay: (from: string, channel: RelayChannel, payload: string) => void
  onClose: (code: number, reason: string) => void
  onError: (err: unknown) => void
}

export class SignalingClient {
  private ws: WebSocket | null = null

  constructor(
    private readonly base: string,
    private readonly teamId: string,
    private readonly idToken: string,
    private readonly name: string,
    private readonly handlers: SignalingHandlers,
  ) {}

  connect(): void {
    const url = buildSignalingUrl(this.base, this.teamId, this.name)
    const ws = new WebSocket(url, signalingSubprotocols(this.idToken))
    this.ws = ws

    ws.onmessage = (event) => {
      const msg = parseServerMessage(event.data)
      if (!msg) return
      switch (msg.type) {
        case 'welcome':
          this.handlers.onWelcome(msg.selfId, msg.peers, sanitizeIceServers(msg.iceServers))
          break
        case 'peer-join':
          this.handlers.onPeerJoin(msg.peer)
          break
        case 'peer-leave':
          this.handlers.onPeerLeave(msg.peerId)
          break
        case 'offer':
        case 'answer':
        case 'ice':
          this.handlers.onSignal(msg.from, msg.type, msg.payload)
          break
        case 'relay':
          this.handlers.onRelay(msg.from, msg.channel, msg.payload)
          break
      }
    }
    ws.onclose = (event) => this.handlers.onClose(event.code, event.reason)
    ws.onerror = (event) => this.handlers.onError(event)
  }

  /** Forward a WebRTC signal to a specific peer. */
  sendSignal(to: string, type: SignalType, payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const message: SignalMessage = { type, to, payload }
    this.ws.send(JSON.stringify(message))
  }

  /** Relay channel data to a peer through the DO (P2P fallback). */
  sendRelay(to: string, channel: RelayChannel, payload: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const message: RelayMessage = { type: 'relay', to, channel, payload }
    this.ws.send(JSON.stringify(message))
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}
