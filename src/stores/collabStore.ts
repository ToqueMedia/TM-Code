import { create } from 'zustand'
import { useBillingStore } from '@/stores/billingStore'
import type { MediaPolicy, PeerInfo } from '@/services/collab/signalingProtocol'
import type { PeerPath } from '@/services/collab/collabMesh'
import type { ChatMessage } from '@/services/collab/collabChat'

// Team collaboration store: presence, ephemeral team chat, and live-preview
// offers/sharing. Populated by collabSessionService over the WebRTC mesh.

interface CollabState {
  /// True while a signaling/mesh session is connected for the active team.
  connected: boolean
  /// Online teammates (excluding self), from signaling presence.
  peers: PeerInfo[]
  /// How MY connection to each teammate flows (direct P2P / TURN / DO relay),
  /// keyed by peerId — feeds the badges on call chips and the presentation.
  peerPaths: Record<string, PeerPath>
  /// Ephemeral team chat transcript (oldest → newest).
  chat: ChatMessage[]
  /// Whether the team chat panel is open.
  chatOpen: boolean
  /// Count of chat messages received while the panel was closed.
  chatUnread: number
  /// Live-preview offers from teammates (their running app, openable here).
  livePreviews: LivePreview[]
  /// Whether WE are currently sharing a live preview of our running app.
  sharingPreview: boolean
  /// True while the dedicated Live Preview dev server (port 7773) is starting
  /// up, before sharing begins — drives a spinner on the share control.
  startingPreview: boolean
  /// Teammates currently typing in the team chat, keyed by uid. `at` is the
  /// last "typing" ping (ms) — the UI expires stale entries on a short TTL so a
  /// crashed/closed peer's indicator can't get stuck on.
  typingPeers: Record<string, { name: string; at: number }>
  /// Per-plan voice/screen limits from the signaling welcome (null = none —
  /// old worker or not connected). Enforced client-side by the media services.
  mediaPolicy: MediaPolicy | null
  /// Whether WE are in the team voice call / mid-join (mic prompt pending).
  voiceInCall: boolean
  voiceJoining: boolean
  /// Our mic mute state + local voice-activity flag (for our own chip in the UI).
  voiceMuted: boolean
  voiceSpeakingSelf: boolean
  /// Final plan-limit countdown (5…1 s) before the call auto-ends; null when
  /// not counting. Rendered red in both voice bars.
  voiceCountdown: number | null
  /// When WE joined the voice call (ms epoch) — drives the elapsed timer.
  voiceCallStartedAt: number | null
  /// Teammates currently in the voice call, keyed by uid — rebuilt from their
  /// idempotent `voice-state` broadcasts; pruned when a peer goes offline.
  voiceRoster: Record<string, VoicePeer>
  /// Whether WE are sharing our screen / mid-start (OS picker open).
  screenSharing: boolean
  screenStarting: boolean
  /// When WE started presenting (ms epoch); null when not presenting.
  screenSharingSince: number | null
  /// The teammate currently presenting (from `screen-state` snapshots) and
  /// when we first learned of this presentation.
  screenPresenter: { uid: string; name: string } | null
  screenPresenterSince: number | null
  /// Whether WE opted in to watch the presenter, and their live stream (set
  /// while watching; a MediaStream is intentionally non-serializable state).
  screenWatching: boolean
  screenRemoteStream: MediaStream | null

  setConnected: (connected: boolean) => void
  setPeers: (peers: PeerInfo[]) => void
  addChat: (msg: ChatMessage) => void
  setChat: (chat: ChatMessage[]) => void
  setChatOpen: (open: boolean) => void
  addLivePreview: (preview: LivePreview) => void
  removeLivePreviewByUid: (uid: string) => void
  setSharingPreview: (sharing: boolean) => void
  setStartingPreview: (starting: boolean) => void
  setPeerTyping: (uid: string, name: string, typing: boolean) => void
  setPeerPath: (peerId: string, path: PeerPath) => void
  setMediaPolicy: (policy: MediaPolicy | null) => void
  setVoiceSelf: (patch: Partial<VoiceSelf>) => void
  /// Upsert (state) or drop (null) a teammate from the voice roster.
  setVoicePeer: (uid: string, state: { name: string; muted: boolean } | null) => void
  setVoicePeerSpeaking: (uid: string, speaking: boolean) => void
  resetVoice: () => void
  setScreenSelf: (
    patch: Partial<Pick<CollabState, 'screenSharing' | 'screenStarting' | 'screenSharingSince'>>,
  ) => void
  setScreenPresenter: (presenter: { uid: string; name: string } | null) => void
  setScreenWatching: (watching: boolean) => void
  setScreenRemoteStream: (stream: MediaStream | null) => void
  resetScreen: () => void
  reset: () => void
}

/** A teammate participating in the voice call. */
export interface VoicePeer {
  name: string
  muted: boolean
  speaking: boolean
}

/** The self-side voice fields settable via setVoiceSelf. */
type VoiceSelf = {
  voiceInCall: boolean
  voiceJoining: boolean
  voiceMuted: boolean
  voiceSpeakingSelf: boolean
  voiceCountdown: number | null
  voiceCallStartedAt: number | null
}

const VOICE_INITIAL: VoiceSelf & { voiceRoster: Record<string, VoicePeer> } = {
  voiceInCall: false,
  voiceJoining: false,
  voiceMuted: false,
  voiceSpeakingSelf: false,
  voiceCountdown: null,
  voiceCallStartedAt: null,
  voiceRoster: {},
}

const SCREEN_INITIAL = {
  screenSharing: false,
  screenStarting: false,
  /** When WE started presenting (ms epoch) — drives the elapsed timer. */
  screenSharingSince: null as number | null,
  screenPresenter: null as { uid: string; name: string } | null,
  /** When we first learned of the current presentation (ms epoch). */
  screenPresenterSince: null as number | null,
  screenWatching: false,
  screenRemoteStream: null as MediaStream | null,
}

/** A teammate's live-preview offer, with the peer id needed to tunnel to them. */
export interface LivePreview {
  peerId: string
  uid: string
  name: string
  note?: string
}

/** Cap on the in-memory chat transcript (disk history is the durable record). */
const MAX_CHAT_IN_MEMORY = 500

export const useCollabStore = create<CollabState>((set) => ({
  connected: false,
  peers: [],
  peerPaths: {},
  chat: [],
  chatOpen: false,
  chatUnread: 0,
  livePreviews: [],
  sharingPreview: false,
  startingPreview: false,
  typingPeers: {},
  mediaPolicy: null,
  ...VOICE_INITIAL,
  ...SCREEN_INITIAL,

  setConnected: (connected) => set({ connected }),
  setPeerPath: (peerId, path) =>
    set((s) => (s.peerPaths[peerId] === path ? s : { peerPaths: { ...s.peerPaths, [peerId]: path } })),
  setMediaPolicy: (policy) => set({ mediaPolicy: policy }),
  setPeers: (peers) =>
    set((s) => {
      // Drop typing + voice-roster entries from teammates no longer present.
      const presentUids = new Set(peers.map((p) => p.uid))
      const typingPeers: Record<string, { name: string; at: number }> = {}
      for (const [uid, info] of Object.entries(s.typingPeers)) {
        if (presentUids.has(uid)) typingPeers[uid] = info
      }
      const voiceRoster: Record<string, VoicePeer> = {}
      for (const [uid, info] of Object.entries(s.voiceRoster)) {
        if (presentUids.has(uid)) voiceRoster[uid] = info
      }
      // A presenter that went offline takes the presentation (and our watching
      // state) down with it.
      const presenterGone = s.screenPresenter && !presentUids.has(s.screenPresenter.uid)
      // Connection-path badges only make sense for peers that still exist.
      const presentPeerIds = new Set(peers.map((p) => p.peerId))
      const peerPaths: Record<string, PeerPath> = {}
      for (const [peerId, path] of Object.entries(s.peerPaths)) {
        if (presentPeerIds.has(peerId)) peerPaths[peerId] = path
      }
      return {
        peers,
        // Drop preview offers from peers that are no longer present.
        livePreviews: s.livePreviews.filter((lp) => peers.some((p) => p.peerId === lp.peerId)),
        typingPeers,
        voiceRoster,
        peerPaths,
        ...(presenterGone
          ? {
              screenPresenter: null,
              screenPresenterSince: null,
              screenWatching: false,
              screenRemoteStream: null,
            }
          : {}),
      }
    }),

  addChat: (msg) =>
    set((s) => {
      if (s.chat.some((m) => m.id === msg.id)) return s // dedup echoes
      // Cap the in-memory transcript so a long session can't grow unbounded
      // (disk history is the durable record; load is itself capped).
      const next = [...s.chat, msg]
      const chat = next.length > MAX_CHAT_IN_MEMORY ? next.slice(-MAX_CHAT_IN_MEMORY) : next
      return { chat, chatUnread: s.chatOpen ? 0 : s.chatUnread + 1 }
    }),
  setChat: (chat) => set({ chat }),
  setChatOpen: (open) => set((s) => ({ chatOpen: open, chatUnread: open ? 0 : s.chatUnread })),

  addLivePreview: (preview) =>
    set((s) => ({
      livePreviews: [...s.livePreviews.filter((lp) => lp.uid !== preview.uid), preview],
    })),
  removeLivePreviewByUid: (uid) =>
    set((s) => ({ livePreviews: s.livePreviews.filter((lp) => lp.uid !== uid) })),
  setSharingPreview: (sharing) => set({ sharingPreview: sharing }),
  setStartingPreview: (starting) => set({ startingPreview: starting }),

  setPeerTyping: (uid, name, typing) =>
    set((s) => {
      const next = { ...s.typingPeers }
      if (typing) next[uid] = { name, at: Date.now() }
      else delete next[uid]
      return { typingPeers: next }
    }),

  setVoiceSelf: (patch) => set(patch),
  setVoicePeer: (uid, state) =>
    set((s) => {
      const next = { ...s.voiceRoster }
      // Preserve the transient `speaking` flag across mute-state upserts.
      if (state) next[uid] = { ...state, speaking: next[uid]?.speaking ?? false }
      else delete next[uid]
      return { voiceRoster: next }
    }),
  setVoicePeerSpeaking: (uid, speaking) =>
    set((s) => {
      const entry = s.voiceRoster[uid]
      // Speaking pings can race a leave/prune — never resurrect an entry.
      if (!entry || entry.speaking === speaking) return s
      return { voiceRoster: { ...s.voiceRoster, [uid]: { ...entry, speaking } } }
    }),
  resetVoice: () => set(VOICE_INITIAL),

  setScreenSelf: (patch) => set(patch),
  setScreenPresenter: (presenter) =>
    set((s) => ({
      screenPresenter: presenter,
      // Stamp when a presentation appears; clear when it ends. An upsert of
      // the SAME presenter keeps the original timestamp.
      screenPresenterSince: presenter
        ? s.screenPresenter?.uid === presenter.uid
          ? s.screenPresenterSince
          : Date.now()
        : null,
    })),
  setScreenWatching: (watching) => set({ screenWatching: watching }),
  setScreenRemoteStream: (stream) => set({ screenRemoteStream: stream }),
  resetScreen: () => set(SCREEN_INITIAL),

  reset: () =>
    set({
      connected: false,
      peers: [],
      peerPaths: {},
      chat: [],
      chatOpen: false,
      chatUnread: 0,
      livePreviews: [],
      sharingPreview: false,
      startingPreview: false,
      typingPeers: {},
      mediaPolicy: null,
      ...VOICE_INITIAL,
      ...SCREEN_INITIAL,
    }),
}))

/// Team collaboration is gated on TEAM MEMBERSHIP (`teamMemberOf`), NOT Pro/Max.
/// A member keeps `teamMemberOf` even when the personal/team billing toggle is
/// in personal mode, so collaboration stays available regardless of billing.
export function canShareCode(): boolean {
  return Boolean(useBillingStore.getState().teamMemberOf)
}
