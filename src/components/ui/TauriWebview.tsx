/**
 * Preview webview — platform-specific.
 *
 * macOS: uses a native wry child webview that loads http://localhost
 * directly. NSAllowsLocalNetworking=YES in src-tauri/Info.plist tells ATS
 * to permit loopback hosts, so WKWebView behaves like a normal browser —
 * full WebSocket, Service Worker, Web Crypto, OAuth, and arbitrary HTTP
 * methods all work. Managed entirely on the Rust side; React sends open/
 * resize/close IPC commands.
 *
 * Windows / Linux: uses a plain <iframe>. WebView2 and WebKitGTK load
 * http://localhost:PORT in iframes natively. The native child webview
 * path on Windows created a cascade of problems:
 *   - HWND child sits above DOM → CSS z-index can't layer menus/dialogs above it
 *   - IPC positioning calls blocked the command thread
 *   - Creation/destruction was slow and sometimes left zombie native windows
 * An iframe has none of these issues: it's a DOM element, uses the parent
 * webview's DNS resolver (Chromium Happy Eyeballs handles localhost), and
 * respects z-index like any other element.
 */
import { memo, forwardRef, useEffect, useLayoutEffect, useRef, useCallback, useImperativeHandle } from 'react'
import { Box } from '@chakra-ui/react'
import { invoke } from '@/utils/invokeMetrics'
import { useLayoutStore } from '@/stores/layoutStore'
import { IS_MAC } from '@/utils/platform'
import { logger } from '@/utils/logger'

interface TauriWebviewProps {
  url?: string
  html?: string
  reloadKey?: number
  frozen?: boolean
  onLocationChange?: (url: string) => void
  /**
   * Pixels to subtract from the webview's bottom edge. Used when an overlay
   * (e.g. the Data Viewer drawer) takes the lower portion of the preview
   * region — instead of parking the whole webview off-screen we shrink it,
   * so the upper part of the preview stays visible above the drawer.
   * Defaults to 0 (no shrink).
   */
  bottomReserveHeight?: number
}

export interface TauriWebviewHandle {
  goBack: () => Promise<boolean>
  goForward: () => Promise<boolean>
  reload: () => Promise<boolean>
}

function htmlToDataUri(html: string): string {
  return `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`
}

// ═══════════════════════════════════════════════════════════════
// Windows / Linux — plain iframe
// ═══════════════════════════════════════════════════════════════

const IframePreview = memo(forwardRef<TauriWebviewHandle, TauriWebviewProps>(function IframePreview({ url, html, reloadKey = 0, onLocationChange }, ref) {
  const resolvedUrl = url || (html ? htmlToDataUri(html) : '')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const syncLocation = useCallback(() => {
    if (!onLocationChange) return
    try {
      const href = iframeRef.current?.contentWindow?.location.href
      if (href) onLocationChange(href)
    } catch {
      if (url) onLocationChange(url)
    }
  }, [onLocationChange, url])

  const navigate = useCallback((script: (win: Window) => void): boolean => {
    const win = iframeRef.current?.contentWindow
    if (!win) return false
    try {
      script(win)
      return true
    } catch (err) {
      logger.warn('preview', 'Iframe navigation unavailable:', err)
      return false
    }
  }, [])

  useImperativeHandle(ref, () => ({
    goBack: async () => navigate(win => win.history.back()),
    goForward: async () => navigate(win => win.history.forward()),
    reload: async () => navigate(win => win.location.reload()),
  }), [navigate])

  return (
    <Box width="100%" height="100%" bg="#0a0a0a" data-preview-webview position="relative">
      {resolvedUrl && (
        <iframe
          ref={iframeRef}
          // key forces remount-on-reload when reloadKey changes (hard reload)
          key={`${resolvedUrl}-${reloadKey}`}
          src={resolvedUrl}
          title="Preview"
          onLoad={syncLocation}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: '#0a0a0a',
            display: 'block',
          }}
          // Permissive sandbox — the dev server is the developer's own code,
          // running on their own machine. Sandbox here mainly serves to keep
          // preview-side errors from breaking the IDE itself.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-downloads"
          allow="clipboard-read; clipboard-write; camera; microphone"
        />
      )}
    </Box>
  )
}))

// ═══════════════════════════════════════════════════════════════
// macOS — native wry child webview
// ═══════════════════════════════════════════════════════════════

// Module-level state for the native webview — survives component unmount/remount
let nativePreviewUrl = ''
let pageIsUnloading = false
let resizePreviewInFlight = false
let queuedResizePreviewArgs: Record<string, unknown> | null = null

if (typeof window !== 'undefined') {
  const markUnloading = () => { pageIsUnloading = true }
  const markLoaded = () => { pageIsUnloading = false }
  window.addEventListener('pagehide', markUnloading, { capture: true })
  window.addEventListener('beforeunload', markUnloading, { capture: true })
  window.addEventListener('pageshow', markLoaded, { capture: true })
}

function firePreviewInvoke(command: string, args?: Record<string, unknown>): void {
  if (pageIsUnloading) return
  if (command === 'resize_preview_webview') {
    fireResizePreviewInvoke(args)
    return
  }
  invoke(command, args).catch(() => {})
}

function fireResizePreviewInvoke(args?: Record<string, unknown>): void {
  if (pageIsUnloading) return
  if (resizePreviewInFlight) {
    queuedResizePreviewArgs = args ?? {}
    return
  }

  resizePreviewInFlight = true
  invoke('resize_preview_webview', args)
    .catch(() => {})
    .finally(() => {
      resizePreviewInFlight = false
      const nextArgs = queuedResizePreviewArgs
      queuedResizePreviewArgs = null
      if (nextArgs && !pageIsUnloading) {
        fireResizePreviewInvoke(nextArgs)
      }
    })
}

function parkPreviewWebview(): void {
  if (!nativePreviewUrl || pageIsUnloading) return
  firePreviewInvoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 })
}

const MacWebview = forwardRef<TauriWebviewHandle, TauriWebviewProps>(function MacWebview({ url, html, reloadKey = 0, frozen = false, bottomReserveHeight = 0, onLocationChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  // Last rect actually sent to the Rust side. Skipping IPCs when the rect
  // matches the last one drops the "ResizeObserver fired but nothing actually
  // moved" cases (parent re-rendered without geometry change, scroll-induced
  // layouts, …) without losing the per-frame responsiveness drag needs.
  // Doubles as the off-screen-park guard: the frozen branch writes the
  // (-9999,-9999) rect here too, so the next syncPosition rebroadcasts the
  // real rect instead of being skipped as "same as before".
  const lastSentRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const overlayCount = useLayoutStore(s => s.overlayCount)
  const maskedByOverlay = overlayCount > 0

  const resolvedUrl = url || (html ? htmlToDataUri(html) : '')

  const navigate = useCallback(async (action: 'back' | 'forward' | 'reload'): Promise<boolean> => {
    if (!nativePreviewUrl || pageIsUnloading) return false
    try {
      await invoke('navigate_preview_webview', { action })
      return true
    } catch (err) {
      logger.warn('preview', `Native webview ${action} failed:`, err)
      return false
    }
  }, [])

  useImperativeHandle(ref, () => ({
    goBack: () => navigate('back'),
    goForward: () => navigate('forward'),
    reload: () => navigate('reload'),
  }), [navigate])

  // Capturing in a ref so `getRect` (a stable callback) reads the current
  // value without invalidating the useCallback dep array — the function
  // identity stays the same, listeners stay attached, but the reserve is
  // always fresh.
  const bottomReserveRef = useRef(bottomReserveHeight)
  bottomReserveRef.current = bottomReserveHeight

  const getRect = () => {
    const el = containerRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    // Shrink the height when an in-region overlay occupies the bottom (e.g.
    // Data Viewer drawer). `Math.max(1, …)` keeps the rect minimally valid
    // when the reserve momentarily exceeds the container — the webview
    // becomes 1px instead of receiving an invalid (negative) height.
    const shrink = bottomReserveRef.current
    const height = shrink > 0 ? Math.max(1, r.height - shrink) : r.height
    return { x: r.left, y: r.top, width: r.width, height }
  }

  const syncPosition = useCallback(() => {
    if (!nativePreviewUrl) return
    const rect = getRect()
    if (!rect) return
    const last = lastSentRectRef.current
    if (last
      && last.x === rect.x
      && last.y === rect.y
      && last.width === rect.width
      && last.height === rect.height
    ) return
    lastSentRectRef.current = rect
    firePreviewInvoke('resize_preview_webview', rect)
  }, [])

  // RAF-coalesced syncPosition for window-level events. The ResizeObserver
  // already runs through RAF; window resize / panelResize fired straight at
  // `syncPosition` which means N listener invocations → N IPCs in the same
  // frame even though the rect only landed on one final value. Routing them
  // through the same RAF cancellation keeps them at ≤1 call per frame.
  const scheduleSync = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(syncPosition)
  }, [syncPosition])

  useEffect(() => {
    if (!resolvedUrl) return

    let active = true
    const timer = setTimeout(async () => {
      if (!active || pageIsUnloading) return
      const rect = getRect()
      if (!rect) return
      try {
        await invoke('open_preview_webview', { url: resolvedUrl, ...rect })
        if (!active || pageIsUnloading) return
        nativePreviewUrl = resolvedUrl
        logger.info('preview', `Webview: ${url || 'static'}`)
      } catch (err) {
        if (active && !pageIsUnloading) logger.error('preview', 'Failed:', err)
      }
    }, 200)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [resolvedUrl, reloadKey, syncPosition, url])

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      parkPreviewWebview()
    }
  }, [])

  useEffect(() => {
    if (nativePreviewUrl) syncPosition()
  }, [syncPosition])

  useEffect(() => {
    if (!onLocationChange) return
    const handleLocation = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string }>).detail
      if (detail?.url) onLocationChange(detail.url)
    }
    window.addEventListener('preview-location', handleLocation)
    return () => window.removeEventListener('preview-location', handleLocation)
  }, [onLocationChange])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(scheduleSync)
    observer.observe(el)
    window.addEventListener('resize', scheduleSync)
    window.addEventListener('panelResize', scheduleSync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('panelResize', scheduleSync)
      cancelAnimationFrame(rafRef.current)
    }
  }, [scheduleSync])

  // Re-sync when the reserve changes — the container's `getBoundingClientRect`
  // hasn't moved, so the ResizeObserver won't fire on its own. Without this,
  // toggling the Data Viewer drawer wouldn't actually shrink/expand the
  // native webview until the next unrelated layout change.
  useLayoutEffect(() => {
    if (!nativePreviewUrl) return
    syncPosition()
  }, [bottomReserveHeight, syncPosition])

  useEffect(() => {
    syncPosition()
  }, [syncPosition])

  // useLayoutEffect — fires synchronously after DOM commit but BEFORE the
  // browser paints. When `frozen` flips from true → false (user opens the
  // preview), this gets the `resize_preview_webview` IPC out the door before
  // the new view becomes visible. With a plain `useEffect` the IPC fires
  // one frame later — long enough for the user to see the iframe background
  // (the dark `text.inverse`) without the webview painted on top of it. The
  // result was a visible "dark flash" right when the view changes.
  useLayoutEffect(() => {
    if (!nativePreviewUrl) return
    if (frozen || maskedByOverlay) {
      const parked = { x: -9999, y: -9999, width: 1, height: 1 }
      // Record the parked rect so the next syncPosition doesn't dedupe
      // against a stale on-screen rect and skip restoration.
      lastSentRectRef.current = parked
      firePreviewInvoke('resize_preview_webview', parked)
    } else {
      syncPosition()
    }
  }, [frozen, maskedByOverlay, syncPosition])

  return <Box ref={containerRef} width="100%" height="100%" bg="#0a0a0a" data-preview-webview />
})

// ═══════════════════════════════════════════════════════════════
// Entry — branch by platform
// ═══════════════════════════════════════════════════════════════

const TauriWebview = forwardRef<TauriWebviewHandle, TauriWebviewProps>(function TauriWebview(props, ref) {
  if (IS_MAC) return <MacWebview ref={ref} {...props} />
  return <IframePreview ref={ref} {...props} />
})

export default TauriWebview

/** Explicitly close the preview webview (e.g., leaving Preview view).
 *  No-op on non-macOS (iframe just unmounts with the React tree). */
export function closePreviewWebview() {
  if (IS_MAC && nativePreviewUrl && !pageIsUnloading) {
    nativePreviewUrl = ''
    firePreviewInvoke('close_preview_webview')
  }
}
