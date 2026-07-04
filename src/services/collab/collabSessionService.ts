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
import { CollabMesh } from '@/services/collab/collabMesh'
import { BulkReassembler } from '@/services/collab/bulkFraming'
import { attachTunnel, detachTunnel, onTunnelMessage, setLocalShare } from '@/services/collab/previewTunnelService'
import {
  buildChatControl,
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
/** Unsubscribe for the RTDB offline-chat queue (durable delivery to members who
 *  were offline at send time). Null when not subscribed / RTDB unconfigured. */
let offlineUnsub: (() => void) | null = null
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

/** Project path that works from either the open-project store or the
 *  cwd-scoped project path. Without the fallback, chat history would neither
 *  load nor persist for cwd-scoped sessions. */
function activeProjectPath(): string | null {
  const ps = useProjectStore.getState()
  return ps.currentProject?.path ?? ps.cmdModeProjectPath ?? null
}

/**
 * Start (or restart) the collaboration session for the team the user belongs
 * to. Idempotent: re-calling for the same room is a no-op; switching teams
 * tears down the old mesh first. Silently does nothing when not in a team.
 */
export async function startCollabSession(): Promise<void> {
  if (!COLLAB_ENABLED) return
  const room = useBillingStore.getState().teamMemberOf
  if (!room) return
  // Synchronous guard: a session for this room is already live OR being opened.
  if (activeRoom === room && (mesh || connecting)) return

  stopCollabSession() // clears wantConnection + any pending reconnect
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
      },
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
        }
      },
    })
    mesh.connect()
    // Wire the live-preview tunnel to send over this mesh.
    attachTunnel((peerId, frame) => mesh?.sendBulk(peerId, frame))

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
  const messages = lines.map(parseStoredChat).filter((m): m is ChatMessage => m !== null)
  if (messages.length > 0) useCollabStore.getState().setChat(messages)
}

/** Tear down the session (team switch, leave, sign-out, project close). */
export function stopCollabSession(): void {
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
  mesh?.disconnect()
  mesh = null
  activeRoom = null
  connecting = false
  detachTunnel()
  bulkReassembler = new BulkReassembler()
  const store = useCollabStore.getState()
  store.setConnected(false)
  store.setPeers([])
  store.setSharingPreview(false)
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
  const wasOpen = useCollabStore.getState().chatOpen
  useCollabStore.getState().addChat(msg)
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
