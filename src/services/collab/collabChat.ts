// Ephemeral team chat over the WebRTC `control` DataChannel. Messages are P2P
// and DTLS-encrypted — they never touch a server. Optional local persistence
// (a JSONL file under app-managed project state) is handled by the session service;
// this module holds the message type + pure (de)serialization so the wire
// format is unit-testable.

/** A single chat message. `id` dedups echoes; `ts` orders the transcript. */
export interface ChatMessage {
  id: string
  uid: string
  name: string
  text: string
  ts: number
}

/** A live-preview offer: a teammate is exposing their running app. */
export interface PreviewOffer {
  /** Sharer identity (display). */
  uid: string
  name: string
  /** Optional note, e.g. "Login flow". */
  note?: string
}

/**
 * A teammate's voice-call state. Broadcast as a FULL idempotent snapshot on
 * every change (join/leave/mute) and replayed to late joiners — receivers just
 * overwrite, so ordering/duplication never corrupts the call roster.
 */
export interface VoiceState {
  uid: string
  name: string
  inCall: boolean
  muted: boolean
}

/**
 * A teammate's screen-share state. Same idempotent-snapshot discipline as
 * VoiceState: broadcast on change, replayed to late joiners, receivers
 * overwrite. `screen-watch` is the viewer-side opt-in — the presenter routes
 * the video track ONLY toward peers that asked to watch (bandwidth gating,
 * mirroring "mic only to in-call peers").
 */
export interface ScreenState {
  uid: string
  name: string
  sharing: boolean
}

/** Control-channel envelopes: chat + typing presence + live-preview offer/stop
 *  + voice-call state/speaking + screen-share state/watch. */
export type ControlMessage =
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'typing'; uid: string; name: string; typing: boolean }
  | { t: 'preview-offer'; offer: PreviewOffer }
  | { t: 'preview-stop'; uid: string }
  | { t: 'voice-state'; state: VoiceState }
  | { t: 'voice-speaking'; uid: string; speaking: boolean }
  | { t: 'screen-state'; state: ScreenState }
  | { t: 'screen-watch'; uid: string; watching: boolean }
  /** Presenter → viewer: the watcher slots are full (plan limit). */
  | { t: 'screen-full'; max: number }
  /** Directed (never broadcast): MY classification of OUR pair's media path.
   *  Needed because the selected pair is one and the traffic symmetric, but
   *  each side only sees its own candidates: the side sending through ITS
   *  TURN allocation knows ('turn'), while the far side receives from the
   *  TURN server's address as a prflx candidate and would report 'direct'.
   *  Both UIs show worst(mine, theirs). */
  | { t: 'path-state'; path: 'direct' | 'turn' }

/** Wrap a chat message for broadcast over the control channel. */
export function buildChatControl(msg: ChatMessage): ControlMessage {
  return { t: 'chat', msg }
}

/** Wrap a voice-state snapshot for broadcast over the control channel. */
export function buildVoiceStateControl(state: VoiceState): ControlMessage {
  return { t: 'voice-state', state }
}

/** Wrap a screen-share snapshot for broadcast over the control channel. */
export function buildScreenStateControl(state: ScreenState): ControlMessage {
  return { t: 'screen-state', state }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.uid === 'string' &&
    typeof m.name === 'string' &&
    typeof m.text === 'string' &&
    typeof m.ts === 'number'
  )
}

/**
 * Validate an inbound control payload (already JSON-parsed by the mesh) into a
 * typed ControlMessage, or null if it's malformed / an unknown type.
 */
export function parseControlMessage(value: unknown): ControlMessage | null {
  if (!value || typeof value !== 'object') return null
  const env = value as Record<string, unknown>
  if (env.t === 'chat' && isChatMessage(env.msg)) {
    return { t: 'chat', msg: env.msg }
  }
  if (
    env.t === 'typing' &&
    typeof env.uid === 'string' &&
    typeof env.name === 'string' &&
    typeof env.typing === 'boolean'
  ) {
    return { t: 'typing', uid: env.uid, name: env.name, typing: env.typing }
  }
  if (env.t === 'preview-offer') {
    const o = env.offer as Record<string, unknown> | undefined
    if (o && typeof o.uid === 'string' && typeof o.name === 'string') {
      return {
        t: 'preview-offer',
        offer: { uid: o.uid, name: o.name, note: typeof o.note === 'string' ? o.note : undefined },
      }
    }
  }
  if (env.t === 'preview-stop' && typeof env.uid === 'string') {
    return { t: 'preview-stop', uid: env.uid }
  }
  if (env.t === 'voice-state') {
    const s = env.state as Record<string, unknown> | undefined
    if (
      s &&
      typeof s.uid === 'string' &&
      typeof s.name === 'string' &&
      typeof s.inCall === 'boolean' &&
      typeof s.muted === 'boolean'
    ) {
      return { t: 'voice-state', state: { uid: s.uid, name: s.name, inCall: s.inCall, muted: s.muted } }
    }
  }
  if (env.t === 'voice-speaking' && typeof env.uid === 'string' && typeof env.speaking === 'boolean') {
    return { t: 'voice-speaking', uid: env.uid, speaking: env.speaking }
  }
  if (env.t === 'screen-state') {
    const s = env.state as Record<string, unknown> | undefined
    if (s && typeof s.uid === 'string' && typeof s.name === 'string' && typeof s.sharing === 'boolean') {
      return { t: 'screen-state', state: { uid: s.uid, name: s.name, sharing: s.sharing } }
    }
  }
  if (env.t === 'screen-watch' && typeof env.uid === 'string' && typeof env.watching === 'boolean') {
    return { t: 'screen-watch', uid: env.uid, watching: env.watching }
  }
  if (env.t === 'screen-full' && typeof env.max === 'number' && Number.isFinite(env.max)) {
    return { t: 'screen-full', max: env.max }
  }
  if (env.t === 'path-state' && (env.path === 'direct' || env.path === 'turn')) {
    return { t: 'path-state', path: env.path }
  }
  return null
}

/** Parse one persisted JSONL line back into a ChatMessage (or null). */
export function parseStoredChat(line: string): ChatMessage | null {
  try {
    const value = JSON.parse(line)
    return isChatMessage(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Drop duplicated ids, keeping the FIRST occurrence (original arrival order).
 * Heals persisted transcripts written before the persist-path dedup existed:
 * every P2P replay / offline-queue redelivery used to append the same message
 * to the JSONL again, which resurfaced as duplicate React keys on load.
 */
export function dedupeChatById(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>()
  return messages.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}
