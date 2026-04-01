/**
 * Native preview via wry — zero iframes.
 * The Rust side manages the webview lifecycle. React only sends open/resize/close commands.
 * The webview persists even when this component unmounts temporarily.
 */
import { useEffect, useRef, useCallback } from 'react'
import { Box } from '@chakra-ui/react'
import { invoke } from '@tauri-apps/api/core'
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

// Module-level state — survives component unmount/remount
let previewUrl = ''

export default function TauriWebview({ url, html, reloadKey = 0, frozen = false }: TauriWebviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)

  const resolvedUrl = url || (html ? htmlToDataUri(html) : '')

  const getRect = () => {
    const el = containerRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  const syncPosition = useCallback(() => {
    if (!previewUrl) return
    const rect = getRect()
    if (!rect) return
    invoke('resize_preview_webview', rect).catch(() => {})
  }, [])

  // Open/update webview
  useEffect(() => {
    if (!resolvedUrl) return

    const timer = setTimeout(async () => {
      const rect = getRect()
      if (!rect) return
      try {
        await invoke('open_preview_webview', { url: resolvedUrl, ...rect })
        previewUrl = resolvedUrl
        logger.info('preview', `Webview: ${url || 'static'}`)
      } catch (err) {
        logger.error('preview', 'Failed:', err)
      }
    }, 200)

    return () => clearTimeout(timer)
  }, [resolvedUrl, reloadKey, syncPosition, url])

  // On unmount: hide webview (move offscreen) so no white flash.
  // Don't close — it persists for when user returns to preview.
  useEffect(() => {
    return () => {
      if (previewUrl) {
        invoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 }).catch(() => {})
      }
    }
  }, [])

  // On mount: bring webview back to correct position
  useEffect(() => {
    if (previewUrl) syncPosition()
  }, [syncPosition])

  // Sync position on resize
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

  // Hide when frozen (during resize), or when component unmounts temporarily
  useEffect(() => {
    // On mount: show at correct position
    syncPosition()

    return () => {
      // On unmount: hide (move offscreen) but DON'T close
      if (previewUrl) {
        invoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 }).catch(() => {})
      }
    }
  }, [syncPosition])

  // Frozen state
  useEffect(() => {
    if (!previewUrl) return
    if (frozen) {
      invoke('resize_preview_webview', { x: -9999, y: -9999, width: 1, height: 1 }).catch(() => {})
    } else {
      syncPosition()
    }
  }, [frozen, syncPosition])

  return <Box ref={containerRef} width="100%" height="100%" bg="#0a0a0a" data-preview-webview />
}

/** Call this to explicitly close the preview webview (e.g., stop server) */
export function closePreviewWebview() {
  previewUrl = ''
  invoke('close_preview_webview').catch(() => {})
}
