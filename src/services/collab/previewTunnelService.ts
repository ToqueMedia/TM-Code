// Live-preview tunnel — the engine. Carries HTTP request/response between team
// members over the WebRTC `bulk` channel (chunked via bulkFraming) with the DO
// relay fallback underneath. Two roles:
//
//   SHARER (A): exposes a local dev-server build (no HMR). On a `tunnel-req`
//     from a teammate, it fetches its own localhost (Rust `tunnel_fetch`,
//     binary-safe) and replies with a `tunnel-res`.
//   VIEWER (B): `tunnelRequest()` sends a `tunnel-req` to the sharer and awaits
//     the matching `tunnel-res` (correlated by `reqId`). The viewer-side local
//     proxy/preview-webview (a later phase) drives these requests.
//
// This module is transport-only: it never reads the bodies (opaque base64). The
// frame send/dispatch is injected by collabSessionService (which owns the mesh).

import { CollabService } from '@/services/collabService'
import { encodeBulk } from '@/services/collab/bulkFraming'
import { isBlockedPreviewPath } from '@/services/collab/previewPathGuard'

export interface TunnelResponse {
  status: number
  headers: [string, string][]
  bodyBase64: string
}

interface TunnelReqMsg {
  reqId: string
  method: string
  path: string
  headers: [string, string][]
  bodyBase64: string
}

/** Sends one already-framed bulk message to a peer — injected by the session. */
type FrameSender = (peerId: string, frame: string) => void

let sendFrame: FrameSender | null = null
/** Local base URL the SHARER is exposing (e.g. http://localhost:4173), or null. */
let localShareBase: string | null = null
/** Peer ids allowed to reach the share — null = any team member. */
let allowedPeers: Set<string> | null = null
/** Pending viewer-side requests, keyed by reqId. */
const pending = new Map<string, { resolve: (r: TunnelResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

const REQUEST_TIMEOUT_MS = 30_000

export function attachTunnel(send: FrameSender): void {
  sendFrame = send
}

export function detachTunnel(): void {
  sendFrame = null
  localShareBase = null
  allowedPeers = null
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('tunnel detached'))
  }
  pending.clear()
}

/**
 * SHARER: begin/stop exposing a local dev-server build over the tunnel.
 * `allowed` = peer ids permitted to reach it (null/empty = any team member).
 */
export function setLocalShare(baseUrl: string | null, allowed?: string[] | null): void {
  localShareBase = baseUrl ? baseUrl.replace(/\/+$/, '') : null
  allowedPeers = allowed && allowed.length ? new Set(allowed) : null
}

export function isSharing(): boolean {
  return localShareBase !== null
}

function send(peerId: string, kind: string, id: string, payload: string): void {
  if (!sendFrame) return
  for (const frame of encodeBulk(kind, id, payload)) sendFrame(peerId, frame)
}

/**
 * Dispatch a fully-reassembled tunnel message from a peer (called by the session
 * after BulkReassembler completes a transfer with one of the `tunnel-*` kinds).
 */
export function onTunnelMessage(peerId: string, kind: string, payload: string): void {
  if (kind === 'tunnel-req') {
    void handleRequest(peerId, payload)
  } else if (kind === 'tunnel-res') {
    resolvePending(payload, null)
  } else if (kind === 'tunnel-err') {
    resolvePending(payload, 'error')
  }
}

// ── SHARER side ────────────────────────────────────────────────────────────

async function handleRequest(peerId: string, payload: string): Promise<void> {
  let req: TunnelReqMsg
  try {
    req = JSON.parse(payload) as TunnelReqMsg
  } catch {
    return
  }
  // Only serve while actively sharing — a teammate can't reach localhost
  // otherwise. (Per-recipient gating is layered on by the share UI later.)
  if (!localShareBase || (allowedPeers && !allowedPeers.has(peerId))) {
    send(peerId, 'tunnel-err', req.reqId, JSON.stringify({ reqId: req.reqId, message: 'not sharing' }))
    return
  }
  // Never tunnel a request for a secret/VCS/key path (defense in depth).
  if (isBlockedPreviewPath(req.path)) {
    send(
      peerId,
      'tunnel-res',
      req.reqId,
      JSON.stringify({ reqId: req.reqId, status: 403, headers: [['content-type', 'text/plain']], bodyBase64: btoa('Forbidden') }),
    )
    return
  }
  try {
    const out = await CollabService.tunnelFetch(
      `${localShareBase}${req.path.startsWith('/') ? '' : '/'}${req.path}`,
      req.method,
      req.headers,
      req.bodyBase64,
    )
    send(
      peerId,
      'tunnel-res',
      req.reqId,
      JSON.stringify({ reqId: req.reqId, status: out.status, headers: out.headers, bodyBase64: out.bodyBase64 }),
    )
  } catch (e) {
    send(
      peerId,
      'tunnel-err',
      req.reqId,
      JSON.stringify({ reqId: req.reqId, message: String((e as Error)?.message ?? e) }),
    )
  }
}

// ── VIEWER side ────────────────────────────────────────────────────────────

/** Send an HTTP request to the sharer and await the response over the tunnel. */
export function tunnelRequest(
  sharerPeerId: string,
  method: string,
  path: string,
  headers: [string, string][],
  bodyBase64 = '',
): Promise<TunnelResponse> {
  return new Promise<TunnelResponse>((resolve, reject) => {
    if (!sendFrame) {
      reject(new Error('tunnel not connected'))
      return
    }
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error('tunnel request timed out'))
    }, REQUEST_TIMEOUT_MS)
    pending.set(reqId, { resolve, reject, timer })
    const req: TunnelReqMsg = { reqId, method, path, headers, bodyBase64 }
    send(sharerPeerId, 'tunnel-req', reqId, JSON.stringify(req))
  })
}

function resolvePending(payload: string, err: 'error' | null): void {
  let parsed: { reqId?: string; message?: string } & Partial<TunnelResponse>
  try {
    parsed = JSON.parse(payload)
  } catch {
    return
  }
  const reqId = parsed.reqId
  if (!reqId) return
  const entry = pending.get(reqId)
  if (!entry) return
  pending.delete(reqId)
  clearTimeout(entry.timer)
  if (err || typeof parsed.status !== 'number') {
    entry.reject(new Error(parsed.message ?? 'tunnel error'))
  } else {
    entry.resolve({
      status: parsed.status,
      headers: parsed.headers ?? [],
      bodyBase64: parsed.bodyBase64 ?? '',
    })
  }
}
