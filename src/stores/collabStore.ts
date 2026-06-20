import { create } from 'zustand'
import { useBillingStore } from '@/stores/billingStore'
import type { PeerInfo } from '@/services/collab/signalingProtocol'
import type { ChatMessage } from '@/services/collab/collabChat'

// Team collaboration store: presence, ephemeral team chat, and live-preview
// offers/sharing. Populated by collabSessionService over the WebRTC mesh.

interface CollabState {
  /// True while a signaling/mesh session is connected for the active team.
  connected: boolean
  /// Online teammates (excluding self), from signaling presence.
  peers: PeerInfo[]
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
  reset: () => void
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
  chat: [],
  chatOpen: false,
  chatUnread: 0,
  livePreviews: [],
  sharingPreview: false,
  startingPreview: false,
  typingPeers: {},

  setConnected: (connected) => set({ connected }),
  setPeers: (peers) =>
    set((s) => {
      // Drop typing entries from teammates that are no longer present.
      const presentUids = new Set(peers.map((p) => p.uid))
      const typingPeers: Record<string, { name: string; at: number }> = {}
      for (const [uid, info] of Object.entries(s.typingPeers)) {
        if (presentUids.has(uid)) typingPeers[uid] = info
      }
      return {
        peers,
        // Drop preview offers from peers that are no longer present.
        livePreviews: s.livePreviews.filter((lp) => peers.some((p) => p.peerId === lp.peerId)),
        typingPeers,
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

  reset: () =>
    set({
      connected: false,
      peers: [],
      chat: [],
      chatOpen: false,
      chatUnread: 0,
      livePreviews: [],
      sharingPreview: false,
      startingPreview: false,
      typingPeers: {},
    }),
}))

/// Team collaboration is gated on TEAM MEMBERSHIP (`teamMemberOf`), NOT Pro/Max.
/// A member keeps `teamMemberOf` even when the personal/team billing toggle is
/// in personal mode, so collaboration stays available regardless of billing.
export function canShareCode(): boolean {
  return Boolean(useBillingStore.getState().teamMemberOf)
}
