// CollabMesh — establishes a full mesh of WebRTC peer connections among the
// online members of a team, using the signaling worker only to exchange SDP +
// ICE. Once connected, team data (changesets, chat) flows P2P over two
// DataChannels per peer:
//   - `control`: small JSON messages (presence, chat, share notifications)
//   - `bulk`:    larger payloads (changeset patches), chunked by the caller
//
// Voice + screen: every connection ALSO pre-negotiates one `sendrecv` audio
// transceiver AND one `sendrecv` video transceiver during the initial
// offer/answer, with no tracks attached. Joining a voice call / starting a
// screen share is then just `sender.replaceTrack(mic|screen | null)` — which
// requires NO renegotiation, so the one-shot signaling handshake stays
// sufficient and there is no offer-glare to handle. While unused the m-lines
// are negotiated but silent (no RTP flows for a null track).
//
// DataChannels are DTLS-encrypted end-to-end and voice is SRTP-encrypted
// end-to-end, so nothing the team shares is ever readable by the signaling
// server. ICE runs STUN-first; when the worker has a Cloudflare Calls TURN key
// configured, the `welcome` carries ephemeral TURN credentials and peers with
// no direct path connect through TURN (which only forwards encrypted packets —
// the E2E privacy model is preserved). Without TURN (or if even TURN fails)
// the DO WebSocket relay remains the last resort for DATA; voice does NOT
// survive that path (media through a WebSocket relay is unusable) — relay
// peers can see call state but cannot send/receive audio.

import { SignalingClient } from './signalingClient'
import {
  shouldInitiate,
  type MediaPolicy,
  type PeerInfo,
  type SignalType,
} from './signalingProtocol'

/** Base STUN config. Ephemeral TURN servers from the welcome (when the worker
 *  has a Calls TURN key) are appended per-session — see onWelcome. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** If a peer's WebRTC channels aren't open within this window, fall back to
 *  relaying its data through the DO (don't wait the full ICE-failure timeout). */
const RELAY_FALLBACK_MS = 8000

/** Default encoder ceiling for the screen-share track (per watcher) when the
 *  caller doesn't pass one (media policy carries the per-plan value). This is
 *  a CEILING — WebRTC congestion control adapts below it on weak uplinks. */
const DEFAULT_SCREEN_MAX_BITRATE_BPS = 4_000_000

/**
 * Prefer codecs that excel at screen content — VP9 (whose screen-content
 * tools are what Meet-class sharing leans on), then AV1, then the engine
 * default order. Must run BEFORE the offer/answer that negotiates the m-line;
 * silently a no-op on engines without codec control (older WebKit).
 */
function preferScreenCodecs(tx: RTCRtpTransceiver): void {
  try {
    const caps = RTCRtpReceiver.getCapabilities?.('video')
    if (!caps?.codecs?.length || typeof tx.setCodecPreferences !== 'function') return
    const score = (c: { mimeType: string }): number =>
      /vp9/i.test(c.mimeType) ? 0 : /av1/i.test(c.mimeType) ? 1 : 2
    tx.setCodecPreferences([...caps.codecs].sort((a, b) => score(a) - score(b)))
  } catch {
    /* codec control unsupported — the negotiated default still works */
  }
}

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

/** How my connection to a given peer is actually flowing.
 *  'direct' = P2P (host↔host on the LAN or srflx across NATs);
 *  'turn'   = P2P through a TURN relay (media works, no direct line);
 *  'relay'  = DO WebSocket data relay (WebRTC failed — data only, NO media). */
export type PeerPath = 'direct' | 'turn' | 'relay'

/**
 * Classify the SELECTED ICE candidate pair from a getStats() report.
 * Standard path: the 'transport' stat carries selectedCandidatePairId.
 * Fallback: a 'candidate-pair' with selected=true (pre-standard) or
 * nominated+succeeded. Either side being a 'relay' candidate means the
 * media is flowing through TURN. Returns null while nothing is selected.
 * Pure and Map-friendly on purpose — unit-tested with synthetic reports.
 */
export function classifySelectedPair(
  report: Iterable<[string, Record<string, unknown>]>,
): 'direct' | 'turn' | null {
  const stats = new Map<string, Record<string, unknown>>()
  for (const [id, entry] of report) stats.set(id, entry)

  let pair: Record<string, unknown> | undefined
  for (const entry of stats.values()) {
    if (entry.type === 'transport' && typeof entry.selectedCandidatePairId === 'string') {
      pair = stats.get(entry.selectedCandidatePairId)
      if (pair) break
    }
  }
  if (!pair) {
    for (const entry of stats.values()) {
      if (entry.type !== 'candidate-pair') continue
      if (entry.selected === true || (entry.nominated === true && entry.state === 'succeeded')) {
        pair = entry
        break
      }
    }
  }
  if (!pair) return null

  const local = typeof pair.localCandidateId === 'string' ? stats.get(pair.localCandidateId) : undefined
  const remote = typeof pair.remoteCandidateId === 'string' ? stats.get(pair.remoteCandidateId) : undefined
  if (!local && !remote) return null
  const isRelay = (c?: Record<string, unknown>) => c?.candidateType === 'relay'
  return isRelay(local) || isRelay(remote) ? 'turn' : 'direct'
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
  /** The peer's remote audio track is live (fires at initial negotiation via
   *  the pre-negotiated voice transceiver; the track stays silent until the
   *  peer joins a call and feeds a real mic track into it). */
  onPeerAudioTrack?: (peer: PeerInfo, track: MediaStreamTrack, stream: MediaStream) => void
  /** Same for the pre-negotiated video transceiver — black/frozen until the
   *  peer starts a screen share and feeds a display track into it. */
  onPeerVideoTrack?: (peer: PeerInfo, track: MediaStreamTrack, stream: MediaStream) => void
  /** Per-plan voice/screen limits from the welcome (null = no limits — old
   *  worker). Fires once per (re)connect, before any peer exists. */
  onMediaPolicy?: (policy: MediaPolicy | null) => void
  /** How data/media to this peer is flowing (direct P2P, TURN, DO relay).
   *  Fires when the connection establishes and again if the selected pair
   *  changes (ICE promotion/restart) or WebRTC falls back to the DO relay. */
  onPeerPath?: (peerId: string, path: PeerPath) => void
}

interface PeerState {
  info: PeerInfo
  pc: RTCPeerConnection
  control?: RTCDataChannel
  bulk?: RTCDataChannel
  /** Pre-negotiated audio transceiver — voice joins/leaves via
   *  `audioTx.sender.replaceTrack`, never via renegotiation. */
  audioTx?: RTCRtpTransceiver
  /** Pre-negotiated video transceiver — screen share via replaceTrack. */
  videoTx?: RTCRtpTransceiver
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
  /** Session ICE config: STUN base + the welcome's ephemeral TURN servers.
   *  Set before any peer exists (peers are only created from welcome onward). */
  private iceServers: RTCIceServer[] = ICE_SERVERS

  constructor(
    private readonly base: string,
    private readonly teamId: string,
    private readonly idToken: string,
    private readonly displayName: string,
    private readonly handlers: MeshHandlers = {},
  ) {}

  connect(): void {
    this.signaling = new SignalingClient(this.base, this.teamId, this.idToken, this.displayName, {
      onWelcome: (selfId, peers, iceServers, mediaPolicy) => {
        this.selfId = selfId
        this.iceServers = iceServers?.length ? [...ICE_SERVERS, ...iceServers] : ICE_SERVERS
        dlog(
          'welcome:', peers.length, 'peers,', iceServers?.length ?? 0, 'TURN server entries,',
          mediaPolicy ? `policy(call≤${mediaPolicy.maxCallParticipants})` : 'no policy',
        )
        this.handlers.onMediaPolicy?.(mediaPolicy)
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

  /**
   * Feed (or clear) our mic track toward ONE peer — `replaceTrack` on the
   * pre-negotiated transceiver, so this never renegotiates. Who gets the track
   * is the voice service's policy (only in-call peers); the mesh just routes.
   * No-op for relay-mode peers: they have no RTCPeerConnection, so voice
   * cannot reach them (see header).
   */
  setVoiceTrackForPeer(peerId: string, track: MediaStreamTrack | null): void {
    const peer = this.peers.get(peerId)
    const sender = peer?.mode === 'p2p' ? peer.audioTx?.sender : undefined
    if (!sender) return
    dlog('voice track', track ? 'ON' : 'off', '→', peerId)
    void sender
      .replaceTrack(track)
      .then(() => {
        if (!track) return
        // Voice must survive a concurrent screen share on a congested uplink:
        // mark the audio sender high-priority so the congestion controller
        // starves the video first, never the narration. Best-effort — the
        // fields are Chromium-first; engines without them ignore the hint.
        const params = sender.getParameters()
        if (!params.encodings?.length) params.encodings = [{}]
        const enc = params.encodings[0] as RTCRtpEncodingParameters & {
          priority?: string
          networkPriority?: string
        }
        enc.priority = 'high'
        enc.networkPriority = 'high'
        return sender.setParameters(params)
      })
      .catch(() => {
        /* pc closed mid-flight — nothing to route anymore */
      })
  }

  /** True when a direct (P2P) audio path to this peer is negotiated. Relay
   *  peers exchange call-state messages fine but can't carry media. */
  hasVoicePath(peerId: string): boolean {
    const peer = this.peers.get(peerId)
    return Boolean(peer && peer.mode === 'p2p' && peer.audioTx)
  }

  /**
   * Feed (or clear) our screen-capture track toward ONE peer — same
   * no-renegotiation contract as setVoiceTrackForPeer. Which peers get it is
   * the screen service's policy (only opted-in watchers). Also caps the
   * encoder bitrate: screen content is mostly static, and without a cap a
   * scroll/video moment would happily eat the whole uplink × N watchers.
   */
  setScreenTrackForPeer(peerId: string, track: MediaStreamTrack | null, maxBitrateBps?: number): void {
    const peer = this.peers.get(peerId)
    const sender = peer?.mode === 'p2p' ? peer.videoTx?.sender : undefined
    if (!sender) return
    dlog('screen track', track ? 'ON' : 'off', '→', peerId)
    void sender
      .replaceTrack(track)
      .then(() => {
        if (!track) return
        const params = sender.getParameters()
        if (!params.encodings?.length) params.encodings = [{}]
        params.encodings[0].maxBitrate = maxBitrateBps ?? DEFAULT_SCREEN_MAX_BITRATE_BPS
        // Text stays sharp under pressure: drop frames before resolution.
        ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
          'maintain-resolution'
        return sender.setParameters(params)
      })
      .catch(() => {
        /* pc closed mid-flight — nothing to route anymore */
      })
  }

  /** True when a direct (P2P) video path to this peer is negotiated. */
  hasScreenPath(peerId: string): boolean {
    const peer = this.peers.get(peerId)
    return Boolean(peer && peer.mode === 'p2p' && peer.videoTx)
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
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
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
    pc.ontrack = (event) => {
      dlog('remote', event.track.kind, 'track ←', info.peerId)
      // addTransceiver-without-stream on the far side → `streams` can be empty.
      const stream = event.streams[0] ?? new MediaStream([event.track])
      if (event.track.kind === 'audio') this.handlers.onPeerAudioTrack?.(info, event.track, stream)
      else if (event.track.kind === 'video') this.handlers.onPeerVideoTrack?.(info, event.track, stream)
    }
    pc.oniceconnectionstatechange = () => dlog('iceConnectionState', info.peerId, pc.iceConnectionState)
    pc.onconnectionstatechange = () => {
      dlog('connectionState', info.peerId, pc.connectionState)
      if (pc.connectionState === 'connected') {
        // Report whether traffic flows direct or through TURN (UI badges), and
        // keep reporting if ICE later promotes/demotes the selected pair.
        this.reportPeerPath(state)
        this.watchSelectedPair(state)
      }
      // P2P couldn't establish (symmetric NAT, mDNS across a VM, …) → don't drop
      // the peer; fall back to relaying its data through the DO. 'closed' here is
      // our own teardown (relay switch / dropPeer) — ignore it.
      if (pc.connectionState === 'failed') this.switchToRelay(state)
    }

    if (initiate) {
      // Initiator owns the channels; the answerer receives them via ondatachannel.
      this.attachChannel(state, pc.createDataChannel('control'), 'control')
      this.attachChannel(state, pc.createDataChannel('bulk'), 'bulk')
      // Pre-negotiate the voice + screen m-lines (trackless) so a later call
      // join / screen share is a pure replaceTrack — see the header. The
      // answerer adopts them in onSignal.
      state.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' })
      state.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' })
      preferScreenCodecs(state.videoTx)
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

  /** Ask the live stats for the selected pair and report direct/TURN to the UI.
   *  Async by nature — guarded so a relay switch or peer drop mid-await can't
   *  publish a stale 'p2p' classification. */
  private reportPeerPath(state: PeerState): void {
    void state.pc
      .getStats()
      .then((report) => {
        if (this.peers.get(state.info.peerId) !== state || state.mode !== 'p2p') return
        const path = classifySelectedPair(report as Iterable<[string, Record<string, unknown>]>)
        if (path) {
          dlog('peerPath', state.info.peerId, path)
          this.handlers.onPeerPath?.(state.info.peerId, path)
        }
      })
      .catch(() => {
        /* stats unavailable — keep the last known path */
      })
  }

  /** Re-classify when ICE switches the selected pair (promotion after a late
   *  direct route appears, or demotion to TURN). Chromium-only event; absent
   *  support just means the connect-time classification stands. */
  private watchSelectedPair(state: PeerState): void {
    try {
      const dtls = state.pc.getSenders().find((s) => s.transport)?.transport
      const ice = dtls?.iceTransport as
        | (RTCIceTransport & { onselectedcandidatepairchange: (() => void) | null })
        | undefined
      if (ice) ice.onselectedcandidatepairchange = () => this.reportPeerPath(state)
    } catch {
      /* older engine without RTCIceTransport surface */
    }
  }

  /** WebRTC failed for this peer — keep it, route its data via the DO relay. */
  private switchToRelay(state: PeerState): void {
    if (state.mode === 'relay') return
    dlog('switchToRelay', state.info.peerId)
    state.mode = 'relay'
    this.handlers.onPeerPath?.(state.info.peerId, 'relay')
    try {
      state.pc.close()
    } catch {
      /* already closed */
    }
    state.control = undefined
    state.bulk = undefined
    // Closing the pc above ended any remote audio/video tracks (the voice and
    // screen services clean up via track.onended). No transceivers → no media.
    state.audioTx = undefined
    state.videoTx = undefined
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
        // Adopt the audio/video transceivers the remote offer created and
        // answer them sendrecv — a remotely-created transceiver defaults to
        // recvonly, which would let us hear/watch but never speak/present.
        // Older clients whose offer carries fewer m-lines simply leave the
        // corresponding tx undefined (that media no-ops toward them).
        for (const tx of state.pc.getTransceivers()) {
          const kind = tx.receiver.track?.kind
          if (kind === 'audio' && !state.audioTx) {
            state.audioTx = tx
            tx.direction = 'sendrecv'
          } else if (kind === 'video' && !state.videoTx) {
            state.videoTx = tx
            tx.direction = 'sendrecv'
            preferScreenCodecs(tx)
          }
        }
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
