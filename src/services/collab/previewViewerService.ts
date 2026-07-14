// Live-preview tunnel — the VIEWER (Member B) glue.
//
// Starts the Rust local proxy, opens a preview window pointed at it, and bridges
// each proxied HTTP request through the mesh tunnel to the sharer:
//
//   preview window → Rust proxy → 'tunnel-proxy-request' event → here →
//   tunnelRequest() over the mesh → sharer's tunnel_fetch → response →
//   tunnel_deliver() → Rust proxy → preview window
//
// Loopback-only, team-gated by the mesh; the window dies when the preview closes.

import { invoke } from '@/utils/invokeMetrics'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { tunnelRequest } from '@/services/collab/previewTunnelService'

interface ProxyRequestEvent {
  reqId: string
  method: string
  path: string
  headers: [string, string][]
  bodyBase64: string
}

/** UTF-8-safe base64 (btoa alone throws on non-ASCII error messages). */
function b64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

/** A readable error page shown inside the preview window when a tunnel request
 *  fails — surfaces the REAL reason (sharer offline, dev server not running on
 *  the shared port, timeout…) instead of a blank "unavailable". */
function errorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#d4d4d4;font:14px/1.6 -apple-system,system-ui,sans-serif}
.box{max-width:460px;padding:28px;text-align:center}h1{font-size:15px;color:#f0f0f0;margin:0 0 10px}
p{margin:0 0 14px;color:#9a9a9a}code{display:block;margin-top:10px;padding:10px 12px;background:#161616;border:1px solid #262626;border-radius:6px;color:#e6a1c0;font:12px/1.5 ui-monospace,monospace;word-break:break-word}</style></head>
<body><div class="box"><h1>${title}</h1><p>The live preview could not load this request. Common causes: the teammate stopped sharing, or their dev server isn't running on the shared port.</p><code>${detail}</code></div></body></html>`
}

let unlisten: UnlistenFn | null = null
/** Peer id of the sharer whose app we're currently viewing. */
let currentSharer: string | null = null

async function deliver(
  reqId: string,
  status: number,
  headers: [string, string][],
  bodyBase64: string,
): Promise<void> {
  try {
    await invoke('tunnel_deliver', { reqId, status, headers, bodyBase64 })
  } catch {
    /* the proxy may have stopped — drop it */
  }
}

/** Open a teammate's running app in a live-preview window (tunneled to them). */
export async function openPreview(sharerPeerId: string, sharerName: string): Promise<void> {
  currentSharer = sharerPeerId

  if (!unlisten) {
    unlisten = await listen<ProxyRequestEvent>('tunnel-proxy-request', async (event) => {
      const e = event.payload
      const sharer = currentSharer
      if (!sharer) {
        await deliver(
          e.reqId,
          503,
          [['content-type', 'text/html; charset=utf-8']],
          b64(errorPage('Live preview closed', 'No teammate preview is currently open.')),
        )
        return
      }
      try {
        const res = await tunnelRequest(sharer, e.method, e.path, e.headers, e.bodyBase64)
        await deliver(e.reqId, res.status, res.headers, res.bodyBase64)
      } catch (err) {
        const detail = (err as Error)?.message ?? String(err)
        // Surface the real reason — invaluable for diagnosing "unavailable"
        // (e.g. "tunnel request timed out" vs the sharer's reqwest error like
        // "Connection refused (os error 61)" when no dev server is on the port).
        console.warn('[live-preview] tunnel request failed:', e.method, e.path, '→', detail)
        await deliver(
          e.reqId,
          502,
          [['content-type', 'text/html; charset=utf-8']],
          b64(errorPage('Live preview unavailable', detail)),
        )
      }
    })
  }

  const port = await invoke<number>('tunnel_proxy_start')
  // 127.0.0.1 (not localhost): the Rust proxy binds 127.0.0.1 only, and the
  // preview webview may resolve `localhost` to IPv6 ::1 first → connection
  // refused → a BLANK preview window ("não apresentava nada"). Same fix the
  // sharer side already carries in shareLivePreview.
  await invoke('tunnel_open_preview_window', {
    url: `http://127.0.0.1:${port}`,
    title: `Live preview — ${sharerName}`,
  })
}

/** Stop viewing: tear down the proxy + listener (the window stays until closed). */
export async function closePreview(): Promise<void> {
  currentSharer = null
  if (unlisten) {
    unlisten()
    unlisten = null
  }
  try {
    await invoke('tunnel_proxy_stop')
  } catch {
    /* idempotent */
  }
}
