// SignalingRoom — one Durable Object instance per team (idFromName = teamId).
//
// Brokers WebRTC handshakes (SDP offer/answer + ICE) and presence between the
// team's online members. It is an EPHEMERAL DUMB RELAY: presence lives in
// memory, nothing is persisted, and `payload` blobs are forwarded verbatim
// without inspection. Changesets and chat never pass through here — they travel
// P2P over the DataChannels these handshakes establish.

import { HttpError, jsonError } from './errors'
import { checkMembership } from './membership'
import { policyForPlan, type MediaPolicy } from './mediaPolicy'
import { parseInbound, routeTargets, tokenFromSubprotocols } from './protocol'
import { mintTurnIceServers, TURN_CACHE_MS, type IceServer } from './turn'
import { COLLAB_SUBPROTOCOL, type Env, type PeerInfo, type ServerMessage } from './types'
import { verifyToken } from './auth'

interface Peer extends PeerInfo {
  socket: WebSocket
}

export class SignalingRoom {
  private readonly env: Env
  private readonly peers = new Map<WebSocket, Peer>()
  /** Room-wide cache of minted TURN credentials (ephemeral, shared within the
   *  team's trust boundary) so joins don't each pay a Calls API round-trip. */
  private turnCache: { servers: IceServer[]; expiresAt: number } | null = null
  /** One "TURN not configured" log per DO lifetime, not one per join. */
  private loggedTurnUnconfigured = false

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonError(new HttpError(426, 'tm_upgrade_required', 'Expected a WebSocket upgrade.'))
    }

    const url = new URL(request.url)
    const room = request.headers.get('x-collab-room') ?? ''
    if (!room) {
      return jsonError(new HttpError(400, 'tm_bad_request', 'Missing team room.'))
    }

    const token = tokenFromSubprotocols(request.headers.get('sec-websocket-protocol'))
    if (!token) {
      return jsonError(new HttpError(401, 'tm_auth_error', 'Missing collaboration token.'))
    }

    // 1) Authenticate the peer.
    let uid: string
    try {
      uid = (await verifyToken(token, this.env)).userId
    } catch (e) {
      if (e instanceof HttpError) return jsonError(e)
      return jsonError(new HttpError(401, 'tm_auth_error', 'Invalid or expired user session.'))
    }

    // 2) Gate on authoritative team membership (fails closed). The same read
    //    resolves the team's plan tier → per-plan media policy in the welcome.
    const membership = await checkMembership(room, uid, token, this.env)
    if (!membership.member) {
      return jsonError(
        new HttpError(403, 'tm_not_team_member', 'You are not a member of this team.'),
      )
    }
    const mediaPolicy = policyForPlan(membership.plan)

    // 3) Mint ephemeral TURN credentials for the welcome (null → the client
    //    stays STUN-only; TURN is an upgrade, never a join dependency).
    const iceServers = await this.turnServers()

    // 4) Upgrade and register the peer.
    const name = (url.searchParams.get('name') || '').slice(0, 120) || uid
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    this.registerPeer(server, uid, name, iceServers, mediaPolicy)

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': COLLAB_SUBPROTOCOL },
    })
  }

  /** Serve TURN credentials from the room cache, minting on miss/expiry. */
  private async turnServers(): Promise<IceServer[] | null> {
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) {
      if (!this.loggedTurnUnconfigured) {
        this.loggedTurnUnconfigured = true
        console.log('[turn] not configured (TURN_KEY_ID/TURN_KEY_API_TOKEN unset) — welcomes go out STUN-only')
      }
      return null
    }
    if (this.turnCache && Date.now() < this.turnCache.expiresAt) return this.turnCache.servers
    const servers = await mintTurnIceServers(this.env)
    if (servers) {
      this.turnCache = { servers, expiresAt: Date.now() + TURN_CACHE_MS }
      console.log('[turn] minted', servers.length, 'ice-server entr(y/ies) — cached for the room')
    }
    return servers
  }

  private registerPeer(
    socket: WebSocket,
    uid: string,
    name: string,
    iceServers: IceServer[] | null,
    mediaPolicy: MediaPolicy,
  ): void {
    const peerId = crypto.randomUUID()
    const self: Peer = { peerId, uid, name, socket }
    this.peers.set(socket, self)

    // Tell the newcomer who's already here (+ TURN credentials when minted,
    // + the per-plan media policy the client enforces).
    const others: PeerInfo[] = [...this.peers.values()]
      .filter((p) => p.socket !== socket)
      .map(({ peerId: id, uid: u, name: n }) => ({ peerId: id, uid: u, name: n }))
    this.send(socket, {
      type: 'welcome',
      selfId: peerId,
      peers: others,
      mediaPolicy,
      ...(iceServers ? { iceServers } : {}),
    })

    // Announce the newcomer to everyone else.
    this.broadcast(socket, { type: 'peer-join', peer: { peerId, uid, name } })

    socket.addEventListener('message', (event) => this.onMessage(self, event.data))
    socket.addEventListener('close', () => this.onClose(self))
    socket.addEventListener('error', () => this.onClose(self))
  }

  private onMessage(sender: Peer, data: string | ArrayBuffer): void {
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const msg = parseInbound(raw)
    if (!msg) return

    const presentIds = [...this.peers.values()].map((p) => p.peerId)
    const targets = routeTargets(msg, presentIds, sender.peerId)
    if (targets.length === 0) return

    // Stamp `from` = sender; rewrite the addressed envelope for the recipient.
    const out: ServerMessage =
      msg.type === 'relay'
        ? { type: 'relay', from: sender.peerId, channel: msg.channel, payload: msg.payload }
        : { type: msg.type, from: sender.peerId, payload: msg.payload }

    for (const peer of this.peers.values()) {
      if (targets.includes(peer.peerId)) this.send(peer.socket, out)
    }
  }

  private onClose(peer: Peer): void {
    if (!this.peers.has(peer.socket)) return
    this.peers.delete(peer.socket)
    this.broadcast(peer.socket, { type: 'peer-leave', peerId: peer.peerId })
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // Peer went away mid-send — drop it; its close handler will clean up.
    }
  }

  private broadcast(except: WebSocket, message: ServerMessage): void {
    for (const peer of this.peers.values()) {
      if (peer.socket !== except) this.send(peer.socket, message)
    }
  }
}
