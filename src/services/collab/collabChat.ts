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

/** Control-channel envelopes: chat + typing presence + live-preview offer/stop. */
export type ControlMessage =
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'typing'; uid: string; name: string; typing: boolean }
  | { t: 'preview-offer'; offer: PreviewOffer }
  | { t: 'preview-stop'; uid: string }

/** Wrap a chat message for broadcast over the control channel. */
export function buildChatControl(msg: ChatMessage): ControlMessage {
  return { t: 'chat', msg }
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
