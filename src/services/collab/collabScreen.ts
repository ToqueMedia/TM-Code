// Team screen share over the collab mesh's pre-negotiated VIDEO transceivers
// (see collabMesh.ts header — start/stop is a pure replaceTrack, never a
// renegotiation, and the signaling worker learns nothing). Coordination uses
// two idempotent envelopes on the existing `control` channel:
//   - `screen-state {uid,name,sharing}`: the presenter's snapshot, broadcast
//     on change and replayed to late joiners (same discipline as voice-state);
//   - `screen-watch {uid,watching}`: a viewer's opt-in, sent point-to-point to
//     the presenter.
//
// Media policy: the display track is routed ONLY toward peers that asked to
// watch — a screen at ~1-2.5 Mbps per receiver is the most expensive thing the
// mesh carries, so nobody pays for pixels they didn't open. One presenter at a
// time (v1): a simultaneous-start race resolves like the live-preview lock —
// the lower uid keeps the floor.
//
// Capture: getDisplayMedia — available in WebView2 (Chromium picker) and in
// WKWebView from macOS Sonoma (system surface picker + Screen Recording TCC).
// Where it's absent, startScreenShare degrades to a clear "not supported"
// toast; nothing else in the collab stack is affected.

import { t } from '@/i18n'
import { useCollabStore } from '@/stores/collabStore'
import { useToastStore } from '@/stores/toastStore'
import { playMessageChime } from '@/utils/notificationSound'
import {
  buildScreenStateControl,
  type ControlMessage,
  type ScreenState,
} from './collabChat'
import type { PeerInfo } from './signalingProtocol'

/** Mesh capabilities the screen service needs — attached by the session
 *  service (same inversion as voice's attachVoiceTransport). */
export interface ScreenTransport {
  broadcastControl(data: ControlMessage): void
  sendControl(peerId: string, data: ControlMessage): void
  setScreenTrackForPeer(peerId: string, track: MediaStreamTrack | null, maxBitrateBps?: number): void
  hasScreenPath(peerId: string): boolean
  peers(): PeerInfo[]
}

/** Which capture surface the user pre-selected. Chromium/WebView2 honor the
 *  preference in the picker; WKWebView shows its own system picker and simply
 *  ignores it — the option is a hint, never a gate. */
export type ScreenSurface = 'monitor' | 'window'

/** Presentation-friendly capture (crisp text over smooth motion), ceilinged
 *  by the plan's media policy when one is present. No policy (old worker) =
 *  no plan limits → the generous default (1440p@20). */
function captureConstraints(surface?: ScreenSurface): DisplayMediaStreamOptions {
  const policy = useCollabStore.getState().mediaPolicy
  const maxHeight = policy?.screenMaxHeight ?? 1440
  const maxFps = policy?.screenMaxFrameRate ?? 20
  const video: MediaTrackConstraints & { displaySurface?: string } = {
    frameRate: { ideal: Math.min(12, maxFps), max: maxFps },
    width: { max: Math.round((maxHeight * 16) / 9) },
    height: { max: maxHeight },
  }
  if (surface) video.displaySurface = surface
  const options: DisplayMediaStreamOptions & {
    selfBrowserSurface?: string
    surfaceSwitching?: string
  } = {
    video,
    audio: false, // narration travels on the voice call, not the capture
    selfBrowserSurface: 'exclude', // never offer the IDE window itself
    surfaceSwitching: 'include', // Chromium: allow switching mid-share
  }
  return options
}

/** Per-watcher encoder ceiling from the plan policy (bps). */
function screenBitrateBps(): number | undefined {
  const kbps = useCollabStore.getState().mediaPolicy?.screenMaxBitrateKbps
  return kbps ? kbps * 1000 : undefined
}

let transport: ScreenTransport | null = null
let getSelf: (() => { uid: string; name: string }) | null = null

let screenStream: MediaStream | null = null
/** peerIds that opted in to watch while WE present. */
const watchers = new Set<string>()
/** Remote video streams by peerId — tracks arrive at mesh negotiation (frozen
 *  until fed); surfaced to the UI only when the user watches that presenter. */
const remoteStreams = new Map<string, MediaStream>()
const warnedNoPath = new Set<string>()

function toast(type: 'info' | 'success' | 'warning' | 'error', message: string): void {
  useToastStore.getState().addToast(type, message)
}

function screenTrack(): MediaStreamTrack | null {
  return screenStream?.getVideoTracks()[0] ?? null
}

function selfScreenState(): ScreenState {
  const id = getSelf?.() ?? { uid: '', name: '' }
  return { uid: id.uid, name: id.name, sharing: useCollabStore.getState().screenSharing }
}

function presenterPeerId(): string | null {
  const presenter = useCollabStore.getState().screenPresenter
  if (!presenter || !transport) return null
  return transport.peers().find((p) => p.uid === presenter.uid)?.peerId ?? null
}

// ── session wiring (called by collabSessionService) ─────────────────────────

export function attachScreenTransport(
  tr: ScreenTransport,
  identity: () => { uid: string; name: string },
): void {
  transport = tr
  getSelf = identity
}

/** Full teardown on session stop — capture must never outlive the session. */
export function resetScreenService(): void {
  stopScreenShare({ broadcast: false })
  watchers.clear()
  remoteStreams.clear()
  warnedNoPath.clear()
  transport = null
  getSelf = null
  useCollabStore.getState().resetScreen()
}

/** Replay our presenting state to a late joiner (mirrors voice/preview). */
export function replayScreenStateTo(peerId: string): void {
  if (!transport) return
  if (useCollabStore.getState().screenSharing) {
    transport.sendControl(peerId, buildScreenStateControl(selfScreenState()))
  }
}

/** A peer left the mesh — forget its watch opt-in and its stream. */
export function onScreenPeerGone(peerId: string): void {
  watchers.delete(peerId)
  remoteStreams.delete(peerId)
  // The presenter-gone case (clearing presenter/watching/stream) is handled
  // by the store's presence pruning, keyed by uid.
}

/** The mesh delivered a peer's (pre-negotiated) remote video track. */
export function onRemoteVideoTrack(peer: PeerInfo, track: MediaStreamTrack, stream: MediaStream): void {
  remoteStreams.set(peer.peerId, stream)
  track.onended = () => {
    remoteStreams.delete(peer.peerId)
    const store = useCollabStore.getState()
    if (store.screenRemoteStream === stream) store.setScreenRemoteStream(null)
  }
  // Reconnect/replace while already watching this presenter → swap the stream.
  const store = useCollabStore.getState()
  if (store.screenWatching && store.screenPresenter?.uid === peer.uid) {
    store.setScreenRemoteStream(stream)
  }
}

/** Route an inbound screen control message (from the session's onControl). */
export function handleScreenControl(peerId: string, control: ControlMessage): void {
  const store = useCollabStore.getState()

  if (control.t === 'screen-watch') {
    if (!store.screenSharing) return // stale watch toward a stopped share
    if (control.watching) {
      // Plan limit: watcher slots (presenter-side, where the fan-out costs).
      const policy = store.mediaPolicy
      if (policy && !watchers.has(peerId) && watchers.size >= policy.maxScreenWatchers) {
        transport?.sendControl(peerId, { t: 'screen-full', max: policy.maxScreenWatchers })
        return
      }
      watchers.add(peerId)
      transport?.setScreenTrackForPeer(peerId, screenTrack(), screenBitrateBps())
      warnIfNoScreenPath(peerId)
    } else {
      watchers.delete(peerId)
      transport?.setScreenTrackForPeer(peerId, null)
    }
    return
  }

  if (control.t === 'screen-full') {
    // Our watch request was declined — the presentation is at capacity.
    if (store.screenWatching) {
      store.setScreenWatching(false)
      store.setScreenRemoteStream(null)
      toast('info', t('team.screenFull').replace('{count}', String(control.max)))
    }
    return
  }

  if (control.t !== 'screen-state') return
  const { state } = control

  if (!state.sharing) {
    if (store.screenPresenter?.uid === state.uid) {
      store.setScreenPresenter(null)
      store.setScreenWatching(false)
      store.setScreenRemoteStream(null)
    }
    return
  }

  // Simultaneous-start race: the lower uid keeps the floor (same rule as the
  // live-preview single-sharer lock), the other side yields deterministically.
  const selfUid = getSelf?.().uid ?? ''
  if (store.screenSharing && state.uid < selfUid) {
    stopScreenShare()
    toast('warning', t('team.screenYielded').replace('{name}', state.name))
  }

  const isNewPresentation = store.screenPresenter?.uid !== state.uid
  store.setScreenPresenter({ uid: state.uid, name: state.name })
  if (isNewPresentation) {
    // Someone else took over — our watch opt-in doesn't carry across.
    store.setScreenWatching(false)
    store.setScreenRemoteStream(null)
    playMessageChime()
    toast('info', t('team.screenStarted').replace('{name}', state.name))
  }
}

// ── user actions ─────────────────────────────────────────────────────────────

/** Start presenting our screen to the team. `surface` pre-selects monitor vs
 *  window in engines that honor the preference (Chromium/WebView2). */
export async function startScreenShare(surface?: ScreenSurface): Promise<void> {
  const store = useCollabStore.getState()
  if (store.screenSharing || store.screenStarting) return
  if (!transport) {
    toast('error', t('team.notConnected'))
    return
  }
  if (store.screenPresenter) {
    toast('info', t('team.screenBusy').replace('{name}', store.screenPresenter.name))
    return
  }
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (typeof media?.getDisplayMedia !== 'function') {
    // WKWebView before macOS Sonoma lands here — capture simply isn't exposed.
    toast('error', t('team.screenNotSupported'))
    return
  }
  store.setScreenSelf({ screenStarting: true })
  try {
    screenStream = await media.getDisplayMedia(captureConstraints(surface))
  } catch {
    // User cancelled the picker OR the OS denied capture (macOS Screen
    // Recording TCC) — the API doesn't let us tell them apart reliably.
    useCollabStore.getState().setScreenSelf({ screenStarting: false })
    toast('warning', t('team.screenDenied'))
    return
  }
  const track = screenTrack()
  if (!track || !transport) {
    screenStream?.getTracks().forEach((tr) => tr.stop())
    screenStream = null
    useCollabStore.getState().setScreenSelf({ screenStarting: false })
    if (track && !transport) return // session torn down mid-picker
    toast('error', t('team.screenNotSupported'))
    return
  }
  // Text-heavy content: prefer resolution over frame rate when bits are short.
  try {
    track.contentHint = 'detail'
  } catch {
    /* older engines: hint is best-effort */
  }
  // The OS-level "Stop sharing" chrome ends the track outside our UI.
  track.onended = () => stopScreenShare()
  watchers.clear()
  useCollabStore.getState().setScreenSelf({
    screenSharing: true,
    screenStarting: false,
    screenSharingSince: Date.now(),
  })
  transport.broadcastControl(buildScreenStateControl(selfScreenState()))
}

/** Stop presenting (UI button, OS stop chrome, yield, or teardown). */
export function stopScreenShare(opts: { broadcast?: boolean } = {}): void {
  const store = useCollabStore.getState()
  const wasSharing = store.screenSharing
  if (transport) {
    for (const peerId of watchers) transport.setScreenTrackForPeer(peerId, null)
  }
  watchers.clear()
  const track = screenTrack()
  if (track) track.onended = null // our own stop must not re-enter via onended
  screenStream?.getTracks().forEach((tr) => tr.stop())
  screenStream = null
  store.setScreenSelf({ screenSharing: false, screenStarting: false, screenSharingSince: null })
  if (wasSharing && opts.broadcast !== false && transport) {
    transport.broadcastControl(buildScreenStateControl(selfScreenState()))
  }
}

/** Opt in to watch the current presenter (opens the viewer). */
export function watchPresenter(): void {
  const store = useCollabStore.getState()
  const presenter = store.screenPresenter
  if (!presenter || !transport || store.screenWatching) return
  const peerId = presenterPeerId()
  if (!peerId) return
  store.setScreenWatching(true)
  store.setScreenRemoteStream(remoteStreams.get(peerId) ?? null)
  transport.sendControl(peerId, {
    t: 'screen-watch',
    uid: getSelf?.().uid ?? '',
    watching: true,
  })
  warnIfNoScreenPath(peerId)
}

/** Close the viewer and tell the presenter to stop sending us pixels. */
export function stopWatching(): void {
  const store = useCollabStore.getState()
  if (!store.screenWatching) return
  const peerId = presenterPeerId()
  store.setScreenWatching(false)
  store.setScreenRemoteStream(null)
  if (peerId && transport) {
    transport.sendControl(peerId, {
      t: 'screen-watch',
      uid: getSelf?.().uid ?? '',
      watching: false,
    })
  }
}

// ── internals ────────────────────────────────────────────────────────────────

function warnIfNoScreenPath(peerId: string): void {
  if (!transport || transport.hasScreenPath(peerId) || warnedNoPath.has(peerId)) return
  warnedNoPath.add(peerId)
  const name = transport.peers().find((p) => p.peerId === peerId)?.name ?? '?'
  toast('warning', t('team.screenNoPath').replace('{name}', name))
}
