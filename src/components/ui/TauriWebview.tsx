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
import { memo, useEffect, useRef, useCallback } from 'react'
import { Box } from '@chakra-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useLayoutStore } from '@/stores/layoutStore'
import { IS_MAC } from '@/utils/platform'
import { logger } from '@/utils/logger'

interface TauriWebviewProps {
  url?: string
  html?: string
  reloadKey?: number
  frozen?: boolean
}

function htmlToDataUri(html: string): string {
  return `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`
}

// ═══════════════════════════════════════════════════════════════
// Windows / Linux — plain iframe
// ═══════════════════════════════════════════════════════════════

const IframePreview = memo(function IframePreview({ url, html, reloadKey = 0 }: TauriWebviewProps) {
  const resolvedUrl = url || (html ? htmlToDataUri(html) : '')

  return (
    <Box width="100%" height="100%" bg="#0a0a0a" data-preview-webview position="relative">
      {resolvedUrl && (
        <iframe
          // key forces remount-on-reload when reloadKey changes (hard reload)
          key={`${resolvedUrl}-${reloadKey}`}
          src={resolvedUrl}
          title="Preview"
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
})

// ═══════════════════════════════════════════════════════════════
// macOS — native wry child webview
// ═══════════════════════════════════════════════════════════════

// Module-level state for the native webview — survives component unmount/remount
let nativePreviewUrl = ''

function MacWebview({ url, html, reloadKey = 0, frozen = false }: TauriWebviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const overlayCount = useLayoutStore(s => s.overlayCount)
  const maskedByOverlay = overlayCount > 0

  const resolvedUrl = url || (html ? htmlToDataUri(html) : '')

  const getRect = () => {
    const el = containerRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  const syncPosition = useCallback(() => {
    if (!nativePreviewUrl) return
    const rect = getRect()
    if (!rect) return
    invoke('resize_preview_webview', rect).catch(() => {})
  }, [])

  useEffect(() => {
    if (!resolvedUrl) return

    const timer = setTimeout(async () => {
      const rect = getRect()
      if (!rect) return
      try {
        await invoke('open_preview_webview', { url: resolvedUrl, ...rect })
        nativePreviewUrl = resolvedUrl
        logger.info('preview', `Webview: ${url || 'static'}`)
      } catch (err) {
        logger.error('preview', 'Failed:', err)
      }
    }, 200)

    return () => clearTimeout(timer)
  }, [resolvedUrl, reloadKey, syncPosition, url])

  useEffect(() => {
    return () => {
      if (nativePreviewUrl) {
        invoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 }).catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    if (nativePreviewUrl) syncPosition()
  }, [syncPosition])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(syncPosition)
    })
    observer.observe(el)
    window.addEventListener('resize', syncPosition)
    window.addEventListener('panelResize', syncPosition)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncPosition)
      window.removeEventListener('panelResize', syncPosition)
    }
  }, [syncPosition])

  useEffect(() => {
    syncPosition()
    return () => {
      if (nativePreviewUrl) {
        invoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 }).catch(() => {})
      }
    }
  }, [syncPosition])

  useEffect(() => {
    if (!nativePreviewUrl) return
    if (frozen || maskedByOverlay) {
      invoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 }).catch(() => {})
    } else {
      syncPosition()
    }
  }, [frozen, maskedByOverlay, syncPosition])

  return <Box ref={containerRef} width="100%" height="100%" bg="#0a0a0a" data-preview-webview />
}

// ═══════════════════════════════════════════════════════════════
// Entry — branch by platform
// ═══════════════════════════════════════════════════════════════

export default function TauriWebview(props: TauriWebviewProps) {
  if (IS_MAC) return <MacWebview {...props} />
  return <IframePreview {...props} />
}

/** Explicitly close the preview webview (e.g., stop server).
 *  No-op on non-macOS (iframe just unmounts with the React tree). */
export function closePreviewWebview() {
  if (IS_MAC && nativePreviewUrl) {
    nativePreviewUrl = ''
    invoke('close_preview_webview').catch(() => {})
  }
}
