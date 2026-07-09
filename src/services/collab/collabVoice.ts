// Team voice calls over the collab mesh's pre-negotiated audio transceivers
// (see collabMesh.ts header — join/leave is a pure replaceTrack, never a
// renegotiation). All coordination (who is in the call, mute, speaking)
// travels as idempotent `voice-state` snapshots on the existing `control`
// channel, so the signaling worker learns nothing about calls and no new
// server surface exists.
//
// Media policy: our mic track is routed ONLY toward peers that are themselves
// in the call (bandwidth + privacy — audio never reaches a teammate who did
// not join). Both directions converge event-driven with no handshake:
//   - my `voice-state {inCall:true}` broadcast → in-call peers feed me theirs;
//   - their state (broadcast on change, replayed to me on connect) → I feed
//     mine to them. Duplicates/reordering are harmless (snapshots overwrite).
//
// Playback: one hidden <audio> element per peer ("sink"), created when the
// remote track arrives (at mesh negotiation — silent until they actually
// join) and kept muted unless WE are in the call. wry enables autoplay in the
// webview, but play() rejections are still retried on the next pointerdown as
// a safety net (first-ever join can outlive its user activation while the OS
// mic prompt sits open).

import { t } from '@/i18n'
import { useCollabStore } from '@/stores/collabStore'
import { useToastStore } from '@/stores/toastStore'
import { playMessageChime } from '@/utils/notificationSound'
import {
  buildVoiceStateControl,
  type ControlMessage,
  type VoiceState,
} from './collabChat'
import type { PeerInfo } from './signalingProtocol'
import { byteTimeDomainRms, createSpeakingTracker } from './voiceActivity'

/** Mesh capabilities the voice service needs — attached by the session service
 *  (same inversion as the preview tunnel's attachTunnel: the mesh instance
 *  stays private to collabSessionService). */
export interface VoiceTransport {
  broadcastControl(data: ControlMessage): void
  sendControl(peerId: string, data: ControlMessage): void
  setVoiceTrackForPeer(peerId: string, track: MediaStreamTrack | null): void
  hasVoicePath(peerId: string): boolean
  peers(): PeerInfo[]
}

/** How often the local mic level is sampled for the speaking indicator. */
const VAD_INTERVAL_MS = 200

let transport: VoiceTransport | null = null
let getSelf: (() => { uid: string; name: string }) | null = null

let micStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let vadTimer: ReturnType<typeof setInterval> | null = null
let lastSentSpeaking = false
/** Peers we already warned "in the call but unreachable" about (relay-only —
 *  no P2P path means no audio). Reset with the session. */
const warnedNoPath = new Set<string>()

interface Sink {
  el: HTMLAudioElement
  track: MediaStreamTrack
}
const sinks = new Map<string, Sink>()
/** Sinks whose play() was rejected (no user activation yet). */
const pendingPlay = new Set<HTMLAudioElement>()
let gestureRetryArmed = false

function toast(type: 'info' | 'success' | 'warning' | 'error', message: string): void {
  useToastStore.getState().addToast(type, message)
}

function micTrack(): MediaStreamTrack | null {
  return micStream?.getAudioTracks()[0] ?? null
}

function selfVoiceState(): VoiceState {
  const id = getSelf?.() ?? { uid: '', name: '' }
  const s = useCollabStore.getState()
  return { uid: id.uid, name: id.name, inCall: s.voiceInCall, muted: s.voiceMuted }
}

function broadcastSelfState(): void {
  transport?.broadcastControl(buildVoiceStateControl(selfVoiceState()))
}

// ── session wiring (called by collabSessionService) ─────────────────────────

/** Wire the voice service to a live mesh. Idempotent per session. */
export function attachVoiceTransport(
  tr: VoiceTransport,
  identity: () => { uid: string; name: string },
): void {
  transport = tr
  getSelf = identity
}

/** Detach from the mesh and drop every voice resource (mic, sinks, VAD).
 *  Called on session teardown — the mic must never outlive the session. */
export function resetVoiceService(): void {
  leaveVoiceCall({ broadcast: false })
  for (const peerId of [...sinks.keys()]) removeSink(peerId)
  warnedNoPath.clear()
  transport = null
  getSelf = null
  useCollabStore.getState().resetVoice()
}

/** A peer's channels just opened — replay our call state so a late joiner
 *  sees the ongoing call (mirrors the chat/preview-offer replay). */
export function replayVoiceStateTo(peerId: string): void {
  if (!transport) return
  if (useCollabStore.getState().voiceInCall) {
    transport.sendControl(peerId, buildVoiceStateControl(selfVoiceState()))
  }
}

/** A peer left the mesh — drop its sink (the roster prunes via setPeers). */
export function onVoicePeerGone(peerId: string): void {
  removeSink(peerId)
}

/** The mesh delivered a peer's (pre-negotiated) remote audio track. */
export function onRemoteAudioTrack(peer: PeerInfo, track: MediaStreamTrack, stream: MediaStream): void {
  removeSink(peer.peerId) // reconnects replace any stale sink
  const el = document.createElement('audio')
  el.autoplay = true
  el.style.display = 'none'
  el.dataset.tmVoicePeer = peer.peerId
  el.srcObject = stream
  // Only call participants hear each other. The sender side already withholds
  // the track from non-participants; this local mute is belt-and-braces
  // (e.g. against a version-skewed peer that broadcasts to everyone).
  el.muted = !useCollabStore.getState().voiceInCall
  document.body.appendChild(el)
  sinks.set(peer.peerId, { el, track })
  tryPlay(el)
  // Fires when the peer's pc closes (drop, relay fallback) — not on mute.
  track.onended = () => removeSink(peer.peerId)
}

/** Route an inbound voice control message (from the session's onControl). */
export function handleVoiceControl(peerId: string, control: ControlMessage): void {
  if (control.t === 'voice-speaking') {
    useCollabStore.getState().setVoicePeerSpeaking(control.uid, control.speaking)
    return
  }
  if (control.t !== 'voice-state') return
  const { state } = control
  const store = useCollabStore.getState()
  const callWasEmpty = Object.keys(store.voiceRoster).length === 0 && !store.voiceInCall

  if (!state.inCall) {
    store.setVoicePeer(state.uid, null)
    // They left: stop feeding them our audio (and never resurrect their chip).
    transport?.setVoiceTrackForPeer(peerId, null)
    return
  }

  store.setVoicePeer(state.uid, { name: state.name, muted: state.muted })
  if (store.voiceInCall) {
    // We're in the call too → make sure THIS peer hears us. Idempotent: a
    // repeated snapshot replaces the sender track with itself.
    transport?.setVoiceTrackForPeer(peerId, micTrack())
    warnIfNoVoicePath(peerId, state.name)
  } else if (callWasEmpty) {
    // A call just started while we're out of it — one nudge, not one per join.
    playMessageChime()
    toast('info', t('team.voiceCallStarted').replace('{name}', state.name))
  }
}

// ── user actions ─────────────────────────────────────────────────────────────

/** Join (or start) the team voice call. Safe to call from any UI surface. */
export async function joinVoiceCall(): Promise<void> {
  const store = useCollabStore.getState()
  if (store.voiceInCall || store.voiceJoining) return
  if (!transport) {
    toast('error', t('team.notConnected'))
    return
  }
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!media?.getUserMedia) {
    toast('error', t('team.voiceNotSupported'))
    return
  }
  store.setVoiceSelf({ voiceJoining: true })
  try {
    micStream = await media.getUserMedia({
      // Browser-native echo cancellation / noise suppression / AGC — without
      // EC, every laptop-speaker participant echoes the whole call back.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (e) {
    useCollabStore.getState().setVoiceSelf({ voiceJoining: false })
    const code = (e as DOMException)?.name
    toast('error', code === 'NotFoundError' ? t('team.voiceNoMic') : t('team.voiceMicDenied'))
    return
  }
  const track = micTrack()
  if (!track) {
    micStream?.getTracks().forEach((tr) => tr.stop())
    micStream = null
    useCollabStore.getState().setVoiceSelf({ voiceJoining: false })
    toast('error', t('team.voiceNoMic'))
    return
  }
  // Re-read the store: the session may have torn down during the mic prompt.
  if (!transport) {
    micStream.getTracks().forEach((tr) => tr.stop())
    micStream = null
    useCollabStore.getState().setVoiceSelf({ voiceJoining: false })
    return
  }
  useCollabStore
    .getState()
    .setVoiceSelf({ voiceInCall: true, voiceJoining: false, voiceMuted: false, voiceSpeakingSelf: false })

  // Feed our mic to everyone already in the call, open our ears, announce.
  const roster = useCollabStore.getState().voiceRoster
  for (const peer of transport.peers()) {
    if (roster[peer.uid]) {
      transport.setVoiceTrackForPeer(peer.peerId, track)
      warnIfNoVoicePath(peer.peerId, peer.name)
    }
  }
  for (const sink of sinks.values()) {
    sink.el.muted = false
    tryPlay(sink.el)
  }
  startVad(micStream)
  broadcastSelfState()
}

/** Leave the call: mic off everywhere, ears muted, state broadcast. */
export function leaveVoiceCall(opts: { broadcast?: boolean } = {}): void {
  const store = useCollabStore.getState()
  const wasInCall = store.voiceInCall
  stopVad()
  if (transport) {
    for (const peer of transport.peers()) transport.setVoiceTrackForPeer(peer.peerId, null)
  }
  micStream?.getTracks().forEach((tr) => tr.stop())
  micStream = null
  for (const sink of sinks.values()) sink.el.muted = true
  store.setVoiceSelf({
    voiceInCall: false,
    voiceJoining: false,
    voiceMuted: false,
    voiceSpeakingSelf: false,
  })
  if (wasInCall && opts.broadcast !== false) broadcastSelfState()
}

/** Toggle our mic. Mute keeps the track live but disabled (silence frames),
 *  so unmute is instant and no track juggling happens on the wire. */
export function toggleVoiceMute(): void {
  const store = useCollabStore.getState()
  if (!store.voiceInCall) return
  const muted = !store.voiceMuted
  const track = micTrack()
  if (track) track.enabled = !muted
  store.setVoiceSelf({ voiceMuted: muted, voiceSpeakingSelf: false })
  if (muted && lastSentSpeaking) {
    // Snap the remote indicator off — don't wait for the VAD hold to lapse.
    lastSentSpeaking = false
    transport?.broadcastControl({ t: 'voice-speaking', uid: selfVoiceState().uid, speaking: false })
  }
  broadcastSelfState()
}

// ── internals ────────────────────────────────────────────────────────────────

function warnIfNoVoicePath(peerId: string, name: string): void {
  if (!transport || transport.hasVoicePath(peerId) || warnedNoPath.has(peerId)) return
  warnedNoPath.add(peerId)
  toast('warning', t('team.voiceNoPath').replace('{name}', name))
}

function startVad(stream: MediaStream): void {
  stopVad()
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return // no VAD — the call still works, just no speaking rings
    audioCtx = new Ctor()
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    // Analyser only — never connected to the destination, so no local echo.
    audioCtx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    const tracker = createSpeakingTracker()
    vadTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      const speaking = tracker.feed(byteTimeDomainRms(buf), Date.now())
      const store = useCollabStore.getState()
      // A muted track produces silence anyway; the && is for snappiness.
      const effective = speaking && !store.voiceMuted
      if (store.voiceSpeakingSelf !== effective) store.setVoiceSelf({ voiceSpeakingSelf: effective })
      if (effective !== lastSentSpeaking && transport) {
        lastSentSpeaking = effective
        transport.broadcastControl({
          t: 'voice-speaking',
          uid: selfVoiceState().uid,
          speaking: effective,
        })
      }
    }, VAD_INTERVAL_MS)
    if (audioCtx.state === 'suspended') void audioCtx.resume()
  } catch {
    /* VAD is best-effort — never let it block the call */
  }
}

function stopVad(): void {
  if (vadTimer) {
    clearInterval(vadTimer)
    vadTimer = null
  }
  lastSentSpeaking = false
  void audioCtx?.close().catch(() => {})
  audioCtx = null
}

function tryPlay(el: HTMLAudioElement): void {
  el.play()
    .then(() => pendingPlay.delete(el))
    .catch(() => {
      // Autoplay blocked (no user activation) — retry on the next gesture.
      pendingPlay.add(el)
      armGestureRetry()
    })
}

function armGestureRetry(): void {
  if (gestureRetryArmed || typeof document === 'undefined') return
  gestureRetryArmed = true
  const retry = () => {
    gestureRetryArmed = false
    for (const el of [...pendingPlay]) tryPlay(el)
  }
  document.addEventListener('pointerdown', retry, { once: true, capture: true })
}

function removeSink(peerId: string): void {
  const sink = sinks.get(peerId)
  if (!sink) return
  sinks.delete(peerId)
  pendingPlay.delete(sink.el)
  sink.track.onended = null
  sink.el.srcObject = null
  sink.el.remove()
}
