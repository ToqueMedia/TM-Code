// Owns the team collaboration session: the WebRTC mesh lifecycle, presence,
// team chat, and the live-preview tunnel (share/open). UI components call these
// functions; the mesh + reassembler live here.
//
// Transport is best-effort but self-healing: if the signaling socket drops
// unexpectedly the session auto-reconnects with capped exponential backoff
// (while the user still belongs to the team). Intentional teardown does not
// reconnect.

import FirebaseAuthService from '@/services/auth/firebaseAuth'
import { CollabService } from '@/services/collabService'
import { CollabMesh, reconcilePeerPath, type PeerPath } from '@/services/collab/collabMesh'
import { BulkReassembler } from '@/services/collab/bulkFraming'
import { attachTunnel, detachTunnel, onTunnelMessage, setLocalShare } from '@/services/collab/previewTunnelService'
import {
  buildChatControl,
  dedupeChatById,
  parseControlMessage,
  parseStoredChat,
  type ChatMessage,
  type PreviewOffer,
} from '@/services/collab/collabChat'
import {
  enqueueOfflineMessage,
  subscribeOfflineQueue,
  getTeamRoster,
} from '@/services/collab/collabOfflineQueue'
import {
  attachVoiceTransport,
  handleVoiceControl,
  joinVoiceCall,
  onRemoteAudioTrack,
  onVoicePeerGone,
  replayVoiceStateTo,
  resetVoiceService,
} from '@/services/collab/collabVoice'
import {
  attachScreenTransport,
  handleScreenControl,
  onRemoteVideoTrack,
  onScreenPeerGone,
  replayScreenStateTo,
  resetScreenService,
} from '@/services/collab/collabScreen'
import { invoke } from '@/utils/invokeMetrics'
import { resolveCollabSignalingUrl } from '@/utils/devUrls'
import { playMessageChime } from '@/utils/notificationSound'
import { stopLivePreviewServer } from '@/services/collab/livePreviewServer'
import { t } from '@/i18n'
import { useAuthStore } from '@/stores/authStore'
import { useBillingStore } from '@/stores/billingStore'
import { useCollabStore } from '@/stores/collabStore'
import { useProjectStore } from '@/stores/projectStore'
import { useToastStore } from '@/stores/toastStore'

/** Kill switch — flip to false to hard-disable collaboration networking. */
export const COLLAB_ENABLED = true

let mesh: CollabMesh | null = null
let bulkReassembler = new BulkReassembler()
/** Room (teamId) the current mesh is connected to — guards redundant restarts. */
let activeRoom: string | null = null
/** Set synchronously while a connect is in flight, to close the async race
 *  (two near-simultaneous starts both passing the `mesh == null` guard before
 *  the awaited getIdToken resolves → ghost peers / "N online"). */
let connecting = false
/** True while we WANT to be connected (set on start, cleared on intentional
 *  stop). Gates auto-reconnect so we never reconnect after leaving the team. */
let wantConnection = false
/** Backoff state for auto-reconnect after an unexpected socket drop. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY_MS = 30_000
/** Our currently-advertised live-preview offer, replayed to new joiners. */
let activeShareOffer: PreviewOffer | null = null
/** Per-peer media-path classifications, reconciled worst-of for the UI.
 *  `local` = what MY getStats says about the pair; `remote` = what the PEER's
 *  getStats says (arrives as a directed 'path-state' control message). One
 *  map per side — see reconcilePeerPath for why a single side can honestly
 *  get it wrong (TURN allocations surface as prflx on the far end). */
const localPeerPaths = new Map<string, PeerPath>()
const remotePeerPaths = new Map<string, PeerPath>()

/** Push the reconciled (worst-of) path for a peer into the store badges. */
function publishPeerPath(peerId: string): void {
  const effective = reconcilePeerPath(localPeerPaths.get(peerId), remotePeerPaths.get(peerId))
  if (effective) useCollabStore.getState().setPeerPath(peerId, effective)
}
/** Unsubscribe for the RTDB offline-chat queue (durable delivery to members who
 *  were offline at send time). Null when not subscribed / RTDB unconfigured. */
let offlineUnsub: (() => void) | null = null
/** Set when an UNEXPECTED socket drop interrupted an active voice call: the
 *  next successful reconnect auto-rejoins (a network blip shouldn't kick you
 *  out of the conversation). Cleared by intentional stops — leaving the team /
 *  signing out must never re-arm the mic. */
let voiceRejoin: { droppedAt: number } | null = null
/** How stale a dropped call may be and still auto-rejoin. Beyond this,
 *  silently re-opening the mic is a privacy surprise, not a convenience. */
const VOICE_REJOIN_WINDOW_MS = 120_000
/** How many of our OWN recent chat messages to replay to a peer that connects
 *  after we spoke (chat is ephemeral P2P — there is no server transcript, so the
 *  sender re-sends; the receiver dedups by message id). */
const CHAT_REPLAY_CAP = 80

function toast(type: 'info' | 'success' | 'warning' | 'error', message: string): void {
  useToastStore.getState().addToast(type, message)
}

function selfIdentity(): { uid: string; name: string; email: string } {
  const user = useAuthStore.getState().user
  return {
    uid: user?.uid ?? '',
    name: user?.displayName ?? user?.email ?? 'Teammate',
    email: user?.email ?? '',
  }
}

/** Path of the currently open project (null when none is open). */
function activeProjectPath(): string | null {
  return useProjectStore.getState().currentProject?.path ?? null
}

/** Normalise a git remote URL into a machine-independent identity: protocol,
 *  credentials and `.git` stripped, `git@host:path` → `host/path`, lowercase.
 *  Two teammates who cloned the same repo produce the same string. */
function normalizeGitRemote(url: string): string {
  let out = url.trim().toLowerCase()
  const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(out)
  if (scp) out = `${scp[1]}/${scp[2]}`
  out = out.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '')
  return out.replace(/\.git$/, '').replace(/\/+$/, '')
}

/**
 * Stable project identity for the room key. Team chat is PER PROJECT — two
 * members only meet when they're in the SAME project. Cross-machine identity:
 * the git remote (teammates clone the same repo) hashed short; projects
 * without a remote fall back to the folder name (same team + same project
 * name = same room, which matches how teams talk about "the project").
 */
async function deriveProjectRoomKey(projectPath: string): Promise<string> {
  let identity = ''
  try {
    const cfg = await invoke<string>('read_file', { path: `${projectPath}/.git/config` })
    const m = /\[remote "origin"\][^[]*?url\s*=\s*([^\n\r]+)/i.exec(cfg)
    if (m) identity = `git:${normalizeGitRemote(m[1])}`
  } catch {
    /* not a git repo (or worktree indirection) — fall back to the name */
  }
  if (!identity) {
    const base = projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? projectPath
    identity = `name:${base.toLowerCase()}`
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Start (or restart) the collaboration session for the team the user belongs
 * to. Idempotent: re-calling for the same room is a no-op; switching teams OR
 * projects tears down the old mesh first (the room is team+project scoped).
 * Silently does nothing when not in a team or without an open project.
 */
export async function startCollabSession(): Promise<void> {
  if (!COLLAB_ENABLED) return
  const teamId = useBillingStore.getState().teamMemberOf
  if (!teamId) return
  // Per-project scope: no open project → no room. A teammate in a DIFFERENT
  // project must not appear online (the room key isolates them), and someone
  // on the Welcome screen is in NO room at all.
  const projectPath = activeProjectPath()
  if (!projectPath) {
    stopCollabSession()
    return
  }
  const room = `${teamId}~${await deriveProjectRoomKey(projectPath)}`
  // Synchronous guard: a session for this room is already live OR being opened.
  // (Two rapid calls both awaiting the key resolve to the SAME room string, so
  // the second lands here and bails; a project switch mid-flight is rescued by
  // the post-token `activeRoom !== room` check below.)
  if (activeRoom === room && (mesh || connecting)) return

  // Internal teardown (NOT stopCollabSession): the reconnect path re-enters
  // here and must keep `voiceRejoin` alive to restore an interrupted call.
  teardownSession() // clears wantConnection + any pending reconnect
  wantConnection = true
  connecting = true
  activeRoom = room

  try {
    const token = await FirebaseAuthService.getInstance().getIdToken()
    // Bail if a newer stop/start superseded us during the await.
    if (!token || activeRoom !== room || !connecting) return

    const { name } = selfIdentity()
    const base = resolveCollabSignalingUrl()
    bulkReassembler = new BulkReassembler()

    mesh = new CollabMesh(base, room, token, name, {
      onPresence: (peers) => {
        useCollabStore.getState().setConnected(true)
        useCollabStore.getState().setPeers(peers)
        reconnectAttempts = 0 // a live presence = a healthy connection
        maybeRejoinVoice()
      },
      // Fires when a peer's channel is actually OPEN (P2P) or relay-ready — the
      // only point at which sends to it land. Presence (peer-join) is too early:
      // a replay sent then is dropped because no path exists yet.
      onPeerConnected: (peer) => {
        if (!mesh) return
        const self = selfIdentity()
        // Replay our OWN recent chat so a teammate who joined AFTER we spoke
        // still sees it (no server transcript; receiver dedups by id).
        const own = useCollabStore
          .getState()
          .chat.filter((m) => m.uid === self.uid)
          .slice(-CHAT_REPLAY_CAP)
        for (const m of own) mesh.sendControl(peer.peerId, buildChatControl(m))
        // Replay an active live-preview offer to the newcomer (single-sharer
        // lock + "open their preview" rely on it).
        if (activeShareOffer) {
          mesh.sendControl(peer.peerId, { t: 'preview-offer' as const, offer: activeShareOffer })
        }
        // Replay our voice-call / screen-share state so the newcomer sees the
        // ongoing call/presentation.
        replayVoiceStateTo(peer.peerId)
        replayScreenStateTo(peer.peerId)
        // Replay our path classification: it computes at ICE 'connected',
        // milliseconds BEFORE the channels open — the eager send in
        // onPeerPath can race a closed channel and drop.
        const knownPath = localPeerPaths.get(peer.peerId)
        if (knownPath && knownPath !== 'relay') {
          mesh.sendControl(peer.peerId, { t: 'path-state' as const, path: knownPath })
        }
      },
      onPeerDisconnected: (peerId) => {
        localPeerPaths.delete(peerId)
        remotePeerPaths.delete(peerId)
        onVoicePeerGone(peerId)
        onScreenPeerGone(peerId)
      },
      onPeerAudioTrack: (peer, track, stream) => onRemoteAudioTrack(peer, track, stream),
      onPeerVideoTrack: (peer, track, stream) => onRemoteVideoTrack(peer, track, stream),
      onPeerPath: (peerId, path) => {
        localPeerPaths.set(peerId, path)
        publishPeerPath(peerId)
        // Tell the peer what OUR stats say about the pair — the side flowing
        // through its own TURN allocation is the only one that knows for sure
        // (the far side sees the relay as a prflx candidate and reads 'direct').
        // 'relay' needs no telling: the DO fallback is symmetric by definition.
        if (path !== 'relay' && mesh) {
          mesh.sendControl(peerId, { t: 'path-state' as const, path })
        }
      },
      onMediaPolicy: (policy) => useCollabStore.getState().setMediaPolicy(policy),
      onSessionClosed: () => {
        useCollabStore.getState().setConnected(false)
        useCollabStore.getState().setPeers([])
        // Unexpected drop (disconnect() uses notify=false) → self-heal.
        scheduleReconnect()
      },
      onBulk: (peerId, data) => {
        const msg = bulkReassembler.accept(data)
        if (msg && msg.kind.startsWith('tunnel-')) onTunnelMessage(peerId, msg.kind, msg.payload)
      },
      onControl: (peerId, data) => {
        const control = parseControlMessage(data)
        if (control?.t === 'chat') onChatReceived(control.msg)
        else if (control?.t === 'typing') {
          useCollabStore.getState().setPeerTyping(control.uid, control.name, control.typing)
        } else if (control?.t === 'preview-offer') {
          // Toast only the FIRST time we see this sharer (replays to new joiners
          // re-send the same offer — don't spam already-aware peers).
          const known = useCollabStore.getState().livePreviews.some((lp) => lp.uid === control.offer.uid)
          useCollabStore.getState().addLivePreview({
            peerId,
            uid: control.offer.uid,
            name: control.offer.name,
            note: control.offer.note,
          })
          if (!known) toast('info', t('team.previewOffered').replace('{name}', control.offer.name))
          // Single-sharer lock — break a simultaneous-start race deterministically:
          // if I'm ALSO sharing, the lower uid keeps the floor and I yield.
          if (useCollabStore.getState().sharingPreview && control.offer.uid < selfIdentity().uid) {
            stopLivePreview()
            toast('warning', t('team.yieldedSharing').replace('{name}', control.offer.name))
          }
        } else if (control?.t === 'preview-stop') {
          useCollabStore.getState().removeLivePreviewByUid(control.uid)
        } else if (control?.t === 'voice-state' || control?.t === 'voice-speaking') {
          handleVoiceControl(peerId, control)
        } else if (
          control?.t === 'screen-state' ||
          control?.t === 'screen-watch' ||
          control?.t === 'screen-full'
        ) {
          handleScreenControl(peerId, control)
        } else if (control?.t === 'path-state') {
          // The peer's view of OUR shared pair — worst-of wins (see the maps).
          remotePeerPaths.set(peerId, control.path)
          publishPeerPath(peerId)
        }
      },
    })
    mesh.connect()
    // Wire the live-preview tunnel to send over this mesh.
    attachTunnel((peerId, frame) => mesh?.sendBulk(peerId, frame))
    // Wire voice calls + screen share to send over this mesh (closures read
    // the live `mesh` var, so a torn-down mesh degrades to no-ops instead of
    // stale sends). One object satisfies both transports structurally.
    const mediaTransport = {
      broadcastControl: (data: Parameters<CollabMesh['broadcastControl']>[0]) =>
        mesh?.broadcastControl(data),
      sendControl: (peerId: string, data: unknown) => mesh?.sendControl(peerId, data),
      setVoiceTrackForPeer: (peerId: string, track: MediaStreamTrack | null) =>
        mesh?.setVoiceTrackForPeer(peerId, track),
      setScreenTrackForPeer: (peerId: string, track: MediaStreamTrack | null, maxBitrateBps?: number) =>
        mesh?.setScreenTrackForPeer(peerId, track, maxBitrateBps),
      hasVoicePath: (peerId: string) => mesh?.hasVoicePath(peerId) ?? false,
      hasScreenPath: (peerId: string) => mesh?.hasScreenPath(peerId) ?? false,
      peers: () => mesh?.currentPeers() ?? [],
    }
    attachVoiceTransport(mediaTransport, () => selfIdentity())
    attachScreenTransport(mediaTransport, () => selfIdentity())

    // Rehydrate recent local chat history for continuity (best-effort).
    void loadChatHistory()

    // Durable offline delivery: drain any messages queued in RTDB while we were
    // offline, and keep receiving ones that land later. onChatReceived dedups by
    // id, so a message we already have (P2P / disk) won't show twice.
    offlineUnsub = subscribeOfflineQueue(room, selfIdentity().uid, (m) => onChatReceived(m))
  } finally {
    connecting = false
  }
}

/** Reconnect after an unexpected socket drop, with capped exponential backoff. */
function scheduleReconnect(): void {
  if (reconnectTimer || !wantConnection || !COLLAB_ENABLED) return
  // Remember an active call across the gap (read BEFORE the reset wipes it);
  // don't overwrite droppedAt on retry cycles — freshness counts from the drop.
  if (useCollabStore.getState().voiceInCall && !voiceRejoin) {
    voiceRejoin = { droppedAt: Date.now() }
  }
  // The mic must not stay hot across the gap — the call does not survive a
  // dropped session (maybeRejoinVoice restores it after the mesh heals). The
  // screen capture stops too and does NOT auto-resume: re-acquiring a capture
  // surface requires a user gesture by design.
  resetVoiceService()
  resetScreenService()
  // Tear down the dead mesh (notify=false → no recursive onSessionClosed) so
  // startCollabSession's guard lets a fresh connect through.
  mesh?.disconnect()
  mesh = null
  activeRoom = null
  connecting = false
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts)
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (wantConnection) void startCollabSession()
  }, delay)
}

async function loadChatHistory(): Promise<void> {
  const projectPath = activeProjectPath()
  if (!projectPath) return
  const lines = await CollabService.chatLoad(projectPath)
  // Dedupe on load: the JSONL is append-only and (pre-fix) replays appended
  // the same message repeatedly — setChat with duplicated ids means duplicated
  // React keys in both chat panels. Keeping the first occurrence heals old
  // transcripts without needing a rewrite primitive on the Rust side.
  const messages = dedupeChatById(
    lines.map(parseStoredChat).filter((m): m is ChatMessage => m !== null),
  )
  if (messages.length > 0) useCollabStore.getState().setChat(messages)
}

/** Auto-rejoin the voice call after a self-healed reconnect (consume-once).
 *  Fires on the first healthy presence; joinVoiceCall itself surfaces mic
 *  errors, so this only announces the success case. */
function maybeRejoinVoice(): void {
  if (!voiceRejoin) return
  const fresh = Date.now() - voiceRejoin.droppedAt <= VOICE_REJOIN_WINDOW_MS
  voiceRejoin = null
  if (!fresh) return
  void joinVoiceCall().then(() => {
    // Transparency: the mic just re-opened without a click — say so.
    if (useCollabStore.getState().voiceInCall) toast('info', t('team.voiceRejoined'))
  })
}

/** Tear down the session (team switch, leave, sign-out, project close).
 *  Intentional by definition — also disarms any pending voice auto-rejoin. */
export function stopCollabSession(): void {
  voiceRejoin = null
  teardownSession()
}

// Closing the IDE window must end the session IMMEDIATELY — mic, screen
// share, live-preview server and presence die with it. On macOS the window
// can close while the PROCESS lives on (dock convention), leaving a zombie
// socket that kept "B is sharing a live preview" alive for the whole team.
// pagehide fires on webview teardown in WKWebView and WebView2 alike, and
// socket.close() flushes the FIN synchronously → the room broadcasts our
// peer-leave right away. The worker-side heartbeat covers the remaining
// cases (crash, sleep, cable pull) where no unload event ever runs.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => stopCollabSession())
}

/** Shared teardown for stopCollabSession AND the (re)start path — keeps
 *  `voiceRejoin` untouched so a reconnect can restore an interrupted call. */
function teardownSession(): void {
  wantConnection = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  // NOTE: reconnectAttempts is NOT reset here — stopCollabSession runs at the
  // top of every startCollabSession (incl. the reconnect path), so resetting
  // would flatten the exponential backoff. It resets only on a SUCCESSFUL
  // presence (onPresence).
  activeShareOffer = null
  offlineUnsub?.()
  offlineUnsub = null
  // Media first, while the mesh is still up: releases the mic + screen
  // capture, clears the senders and removes every sink. Never let capture
  // devices outlive the session.
  resetVoiceService()
  resetScreenService()
  mesh?.disconnect()
  mesh = null
  activeRoom = null
  connecting = false
  detachTunnel()
  bulkReassembler = new BulkReassembler()
  localPeerPaths.clear()
  remotePeerPaths.clear()
  const store = useCollabStore.getState()
  store.setConnected(false)
  store.setPeers([])
  store.setSharingPreview(false)
  store.setMediaPolicy(null)
  // Tearing down the session (team/project switch, sign-out) must also kill any
  // Live Preview server we started — it has no reason to outlive the session.
  void stopLivePreviewServer()
}

// ── Team chat ──────────────────────────────────────────────────────────────

function persistChat(msg: ChatMessage): void {
  const projectPath = activeProjectPath()
  if (!projectPath) return // in-memory only when no project is open
  void CollabService.chatAppend(projectPath, JSON.stringify(msg))
}

function onChatReceived(msg: ChatMessage): void {
  const store = useCollabStore.getState()
  // Re-deliveries are ROUTINE, not exceptional: the P2P replay re-sends the
  // sender's recent messages to every late joiner, and the RTDB offline queue
  // can hand us a message that already arrived P2P. addChat always deduped the
  // UI — but persisting unconditionally appended a duplicate JSONL line per
  // re-delivery, which came back as a duplicated transcript (duplicate React
  // keys) on the next load. Drop known ids before ANY side effect.
  if (store.chat.some((m) => m.id === msg.id)) return
  const wasOpen = store.chatOpen
  store.addChat(msg)
  persistChat(msg)
  // Short chime to wake the user to an incoming message — ONLY when the chat
  // panel is closed (an open panel already shows the message).
  if (!wasOpen) playMessageChime()
}

/** Send a chat message to the team: broadcast P2P + echo locally + persist. */
export function sendChatMessage(text: string): void {
  const trimmed = text.trim()
  if (!trimmed || !mesh) return
  const self = selfIdentity()
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    uid: self.uid,
    name: self.name,
    text: trimmed.slice(0, 4000),
    ts: Date.now(),
  }
  mesh.broadcastControl(buildChatControl(msg))
  useCollabStore.getState().addChat(msg)
  persistChat(msg)
  // Queue in RTDB for teammates who weren't online to get it P2P (offline
  // delivery). Best-effort + no-op when RTDB isn't configured.
  void enqueueForOffline(msg)
}

/** Queue a just-sent message for team members who weren't online to receive it
 *  P2P (roster − self − currently-present peers). */
async function enqueueForOffline(msg: ChatMessage): Promise<void> {
  const teamId = activeRoom
  if (!teamId) return
  const roster = await getTeamRoster(teamId)
  if (roster.length === 0) return
  const self = selfIdentity().uid
  const onlineUids = new Set((mesh?.currentPeers() ?? []).map((p) => p.uid))
  const pending = roster.filter((uid) => uid !== self && !onlineUids.has(uid))
  if (pending.length > 0) await enqueueOfflineMessage(teamId, msg, pending)
}

/**
 * Broadcast our typing state to the team (P2P over the control channel; never
 * persisted, never echoed to self). Throttling is the caller's job — see
 * `useTeamTyping`. No-op when not connected.
 */
export function sendTypingState(typing: boolean): void {
  if (!mesh) return
  const self = selfIdentity()
  mesh.broadcastControl({ t: 'typing' as const, uid: self.uid, name: self.name, typing })
}

// ── Live preview ───────────────────────────────────────────────────────────

/**
 * SHARER: advertise the static build server (on `port`) as a live preview — to
 * everyone, or to specific peers. Returns false (and toasts) when there is no
 * mesh, so the caller can tear the build server back down. The offer is cached
 * and replayed to teammates who join later (see onPresence).
 */
export function shareLivePreview(port: number, note?: string, targetPeerIds?: string[]): boolean {
  if (!mesh) {
    toast('error', t('team.notConnected'))
    return false
  }
  // 127.0.0.1 (not localhost): the static server binds 127.0.0.1, but
  // `localhost` may resolve to IPv6 ::1 first (Node ≥17) → the sharer's
  // tunnel_fetch would hit a dead address. 127.0.0.1 always lands.
  setLocalShare(`http://127.0.0.1:${port}`, targetPeerIds ?? null)
  const self = selfIdentity()
  const offer: PreviewOffer = { uid: self.uid, name: self.name, note }
  activeShareOffer = offer
  const offerMsg = { t: 'preview-offer' as const, offer }
  if (targetPeerIds && targetPeerIds.length) {
    for (const peerId of targetPeerIds) mesh.sendControl(peerId, offerMsg)
  } else {
    mesh.broadcastControl(offerMsg)
  }
  useCollabStore.getState().setSharingPreview(true)
  toast('success', t('team.previewSharing'))
  return true
}

/** SHARER: stop exposing the live preview, tell the team to drop it, and KILL
 *  the dedicated 7773 dev server (every stop path — UI, /live-preview command,
 *  yield-to-lower-uid — funnels through here). The Chat preview server is left
 *  untouched. */
export function stopLivePreview(): void {
  setLocalShare(null)
  activeShareOffer = null
  const self = selfIdentity()
  mesh?.broadcastControl({ t: 'preview-stop' as const, uid: self.uid })
  useCollabStore.getState().setSharingPreview(false)
  void stopLivePreviewServer()
}
