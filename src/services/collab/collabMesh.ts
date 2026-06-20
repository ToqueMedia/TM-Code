// CollabMesh — establishes a full mesh of WebRTC peer connections among the
// online members of a team, using the signaling worker only to exchange SDP +
// ICE. Once connected, team data (changesets, chat) flows P2P over two
// DataChannels per peer:
//   - `control`: small JSON messages (presence, chat, share notifications)
//   - `bulk`:    larger payloads (changeset patches), chunked by the caller
//
// DataChannels are DTLS-encrypted end-to-end, so nothing the team shares is
// ever readable by the signaling server. This is STUN-only (v1): if a peer is
// behind a symmetric NAT and no direct path exists, that peer connection simply
// fails — surfaced via onPeerFailed. TURN is a documented follow-up.

import { SignalingClient } from './signalingClient'
import {
  shouldInitiate,
  type PeerInfo,
  type SignalType,
} from './signalingProtocol'

/** STUN-only ICE configuration (decision: v1 has no TURN). */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** If a peer's WebRTC channels aren't open within this window, fall back to
 *  relaying its data through the DO (don't wait the full ICE-failure timeout). */
const RELAY_FALLBACK_MS = 8000

/** Diagnostic logger for the WebRTC handshake (enable while debugging P2P). */
const COLLAB_MESH_DEBUG = true
function dlog(...args: unknown[]): void {
  if (COLLAB_MESH_DEBUG) console.info('[collab-mesh]', ...args)
}
/** Summarize an ICE candidate line: type (host/srflx/relay), mDNS, address. */
function candidateKind(candidate: string): string {
  const typ = /\btyp (\w+)/.exec(candidate)?.[1] ?? '?'
  const addr = candidate.split(' ')[4] ?? ''
  return `${typ}${candidate.includes('.local') ? ' MDNS' : ''} ${addr}`
}

export interface MeshHandlers {
  /** A peer's DataChannels are open and ready. */
  onPeerConnected?: (peer: PeerInfo) => void
  /** A peer left or its connection dropped/failed. */
  onPeerDisconnected?: (peerId: string) => void
  /** A JSON message arrived on a peer's `control` channel. */
  onControl?: (peerId: string, data: unknown) => void
  /** A message arrived on a peer's `bulk` channel (changeset chunks). */
  onBulk?: (peerId: string, data: string) => void
  /** Presence roster changed (peer joined/left). */
  onPresence?: (peers: PeerInfo[]) => void
  /** The signaling socket dropped (not via disconnect()) — session is over. */
  onSessionClosed?: () => void
}

interface PeerState {
  info: PeerInfo
  pc: RTCPeerConnection
  control?: RTCDataChannel
  bulk?: RTCDataChannel
  /** 'p2p' = direct DataChannels; 'relay' = data forwarded via the DO when the
   *  WebRTC connection couldn't be established. */
  mode: 'p2p' | 'relay'
  /** Whether onPeerConnected has already fired for this peer. */
  ready: boolean
  /** Pending relay-fallback timer (cleared once ready or switched). */
  timer?: ReturnType<typeof setTimeout>
}

export class CollabMesh {
  private signaling: SignalingClient | null = null
  private selfId = ''
  private readonly peers = new Map<string, PeerState>()

  constructor(
    private readonly base: string,
    private readonly teamId: string,
    private readonly idToken: string,
    private readonly displayName: string,
    private readonly handlers: MeshHandlers = {},
  ) {}

  connect(): void {
    this.signaling = new SignalingClient(this.base, this.teamId, this.idToken, this.displayName, {
      onWelcome: (selfId, peers) => {
        this.selfId = selfId
        for (const peer of peers) this.addPeer(peer)
        this.emitPresence()
      },
      onPeerJoin: (peer) => {
        this.addPeer(peer)
        this.emitPresence()
      },
      onPeerLeave: (peerId) => {
        this.dropPeer(peerId)
        this.emitPresence()
      },
      onSignal: (from, type, payload) => void this.onSignal(from, type, payload),
      onRelay: (from, channel, payload) => {
        // P2P-fallback path: handle relayed data exactly like a DataChannel msg.
        if (channel === 'control') this.dispatchControl(from, payload)
        else this.dispatchBulk(from, payload)
      },
      onClose: () => this.teardown(true),
      onError: () => {
        /* surfaced via onClose when the socket drops */
      },
    })
    this.signaling.connect()
  }

  disconnect(): void {
    this.teardown(false)
    this.signaling?.close()
    this.signaling = null
  }

  /** Send a JSON control message to one peer (DataChannel, or DO relay). */
  sendControl(peerId: string, data: unknown): void {
    const peer = this.peers.get(peerId)
    if (peer) this.sendOn(peer, 'control', JSON.stringify(data))
  }

  /** Broadcast a JSON control message to every connected peer. */
  broadcastControl(data: unknown): void {
    const json = JSON.stringify(data)
    let p2p = 0
    let relay = 0
    for (const peer of this.peers.values()) {
      const via = this.sendOn(peer, 'control', json)
      if (via === 'p2p') p2p += 1
      else if (via === 'relay') relay += 1
    }
    dlog('broadcastControl →', this.peers.size, 'peers (', p2p, 'p2p,', relay, 'relay)')
  }

  /** Send a raw string over a peer's bulk channel (caller chunks large data). */
  sendBulk(peerId: string, data: string): void {
    const peer = this.peers.get(peerId)
    if (peer) this.sendOn(peer, 'bulk', data)
  }

  /** Route a payload to a peer over its open DataChannel, or via the DO relay
   *  when the peer fell back to relay mode. Returns the path used (or null). */
  private sendOn(peer: PeerState, channel: 'control' | 'bulk', payload: string): 'p2p' | 'relay' | null {
    const dc = channel === 'control' ? peer.control : peer.bulk
    if (dc?.readyState === 'open') {
      dc.send(payload)
      return 'p2p'
    }
    if (peer.mode === 'relay') {
      this.signaling?.sendRelay(peer.info.peerId, channel, payload)
      return 'relay'
    }
    return null
  }

  private dispatchControl(peerId: string, raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    this.handlers.onControl?.(peerId, parsed)
  }

  private dispatchBulk(peerId: string, raw: string): void {
    this.handlers.onBulk?.(peerId, raw)
  }

  currentPeers(): PeerInfo[] {
    return [...this.peers.values()].map((p) => p.info)
  }

  // ── internals ────────────────────────────────────────────────────────────

  private addPeer(info: PeerInfo): void {
    if (this.peers.has(info.peerId)) return
    const initiate = shouldInitiate(this.selfId, info.peerId)
    dlog('addPeer', info.peerId, 'self=', this.selfId, 'initiate=', initiate)
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const state: PeerState = { info, pc, mode: 'p2p', ready: false }
    this.peers.set(info.peerId, state)
    // Don't wait the full ICE timeout — relay if not connected within the window.
    state.timer = setTimeout(() => {
      if (!state.ready) this.switchToRelay(state)
    }, RELAY_FALLBACK_MS)

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        dlog('local ICE →', info.peerId, candidateKind(event.candidate.candidate))
        this.signaling?.sendSignal(info.peerId, 'ice', event.candidate)
      } else {
        dlog('local ICE gathering complete for', info.peerId)
      }
    }
    pc.oniceconnectionstatechange = () => dlog('iceConnectionState', info.peerId, pc.iceConnectionState)
    pc.onconnectionstatechange = () => {
      dlog('connectionState', info.peerId, pc.connectionState)
      // P2P couldn't establish (symmetric NAT, mDNS across a VM, …) → don't drop
      // the peer; fall back to relaying its data through the DO. 'closed' here is
      // our own teardown (relay switch / dropPeer) — ignore it.
      if (pc.connectionState === 'failed') this.switchToRelay(state)
    }

    if (initiate) {
      // Initiator owns the channels; the answerer receives them via ondatachannel.
      this.attachChannel(state, pc.createDataChannel('control'), 'control')
      this.attachChannel(state, pc.createDataChannel('bulk'), 'bulk')
      void this.makeOffer(state)
    } else {
      pc.ondatachannel = (event) => {
        const label = event.channel.label
        if (label === 'control' || label === 'bulk') this.attachChannel(state, event.channel, label)
      }
    }
  }

  private attachChannel(state: PeerState, channel: RTCDataChannel, label: 'control' | 'bulk'): void {
    state[label] = channel
    channel.onmessage = (event) => {
      if (label === 'control') this.dispatchControl(state.info.peerId, String(event.data))
      else this.dispatchBulk(state.info.peerId, String(event.data))
    }
    channel.onopen = () => {
      dlog('channel OPEN', label, '←', state.info.peerId)
      // Report "connected" once both channels are open.
      if (state.control?.readyState === 'open' && state.bulk?.readyState === 'open') {
        this.markReady(state)
      }
    }
  }

  /** WebRTC failed for this peer — keep it, route its data via the DO relay. */
  private switchToRelay(state: PeerState): void {
    if (state.mode === 'relay') return
    dlog('switchToRelay', state.info.peerId)
    state.mode = 'relay'
    try {
      state.pc.close()
    } catch {
      /* already closed */
    }
    state.control = undefined
    state.bulk = undefined
    // The relay path (the WebSocket) is already up → the peer is usable now.
    this.markReady(state)
  }

  /** Fire onPeerConnected once per peer (P2P channels open OR relay ready). */
  private markReady(state: PeerState): void {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.ready) return
    state.ready = true
    this.handlers.onPeerConnected?.(state.info)
  }

  private async makeOffer(state: PeerState): Promise<void> {
    const offer = await state.pc.createOffer()
    await state.pc.setLocalDescription(offer)
    dlog('offer →', state.info.peerId)
    this.signaling?.sendSignal(state.info.peerId, 'offer', offer)
  }

  private async onSignal(from: string, type: SignalType, payload: unknown): Promise<void> {
    const state = this.peers.get(from)
    if (!state) {
      dlog('signal', type, 'from UNKNOWN peer', from)
      return
    }
    dlog('signal', type, '←', from)
    try {
      if (type === 'offer') {
        await state.pc.setRemoteDescription(payload as RTCSessionDescriptionInit)
        const answer = await state.pc.createAnswer()
        await state.pc.setLocalDescription(answer)
        dlog('answer →', from)
        this.signaling?.sendSignal(from, 'answer', answer)
      } else if (type === 'answer') {
        await state.pc.setRemoteDescription(payload as RTCSessionDescriptionInit)
      } else if (type === 'ice') {
        await state.pc.addIceCandidate(payload as RTCIceCandidateInit)
      }
    } catch (e) {
      // A malformed/late signal shouldn't tear down the whole mesh — but log it.
      dlog('signal', type, 'from', from, 'ERROR', (e as Error)?.message ?? e)
    }
  }

  private dropPeer(peerId: string): void {
    const state = this.peers.get(peerId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    try {
      state.pc.close()
    } catch {
      /* already closed */
    }
    this.peers.delete(peerId)
    this.handlers.onPeerDisconnected?.(peerId)
  }

  private teardown(notify: boolean): void {
    for (const peerId of [...this.peers.keys()]) this.dropPeer(peerId)
    this.selfId = ''
    if (notify) this.handlers.onSessionClosed?.()
  }

  private emitPresence(): void {
    this.handlers.onPresence?.(this.currentPeers())
  }
}
