import { memo, useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { invoke } from '@/utils/invokeMetrics'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Flex, Box, Text, IconButton, HStack, Button } from '@chakra-ui/react'
import { IS_MAC } from '@/utils/platform'
import { AnimatePresence, motion } from 'framer-motion'
import { FiRefreshCw, FiExternalLink, FiSquare, FiTerminal, FiChevronDown, FiTrash2, FiLock, FiGlobe, FiMaximize2, FiMinimize2, FiZap, FiSend, FiUpload, FiCamera, FiDatabase } from 'react-icons/fi'
import { useChatStore, generateId } from '../../stores/chatStore'
import { enqueue as enqueueMessage } from '../../services/agent/messageQueue'
import { useLayoutStore, selectFrontendUrl, selectBackendUrl, selectProjectKind, type DevServerLogEntry } from '../../stores/layoutStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useBillingStore } from '../../stores/billingStore'
import { useToastStore } from '../../stores/toastStore'
import { createImageAttachmentFromClipboard } from '../../services/attachmentService'
import { devServerManager } from '../../services/devServerManager'
import StaticPreviewBuilder from '../../services/agent/staticPreviewBuilder'
import MessageBubble from '../chat/MessageBubble'
import PromptBar from '../PromptBar'
import PermissionDialog from '../chat/PermissionDialog'
import HttpClientPanel from '../http-client/HttpClientPanel'
import DataViewerView from './DataViewerView'
import { useMessageWindow } from '../../hooks/useMessageWindow'
import TauriWebview, { closePreviewWebview } from '../ui/TauriWebview'
import AgentLogo from '../ui/AgentLogo'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const STORAGE_KEY = 'preview-chat-width'
const CONSOLE_STORAGE_KEY = 'preview-console-height'
const HTTP_DRAWER_OPEN_KEY = 'preview-http-drawer-open'
const DATA_DRAWER_HEIGHT_KEY = 'preview-data-drawer-height'
const DATA_DRAWER_OPEN_KEY = 'preview-data-drawer-open'
const MIN_DATA_DRAWER_HEIGHT = 260
const MAX_DATA_DRAWER_HEIGHT = 720
const DEFAULT_DATA_DRAWER_HEIGHT = 420
const MIN_WIDTH = 280
const MAX_WIDTH = 640
const DEFAULT_WIDTH = 380
const MIN_CONSOLE_HEIGHT = 80
const MAX_CONSOLE_HEIGHT = 400
const DEFAULT_CONSOLE_HEIGHT = 180

const LOG_COLORS: Record<string, string> = {
  info: tokens.colors.text.secondary,
  warn: '#e3b341',
  error: '#f85149',
}

function PreviewView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const billingPlan = useBillingStore(s => s.plan)
  // Gate matches the BACKEND's multimodal-preprocessing condition exactly:
  //   proxy.ts: `if (planConfig.planId !== 'explorer' && ...) processMultimodal()`
  // Any non-explorer plan reaches the vision sidecar at the worker. Mirroring
  // that here keeps the button visible whenever the action will succeed —
  // previously a tighter "vibe/pro/max" whitelist hid the button on accounts
  // whose plan string didn't match the literal list (legacy values, hydration
  // races, future tiers added in Firestore before the IDE knows them). When
  // plan is undefined/null (auth still hydrating), default to visible: at worst
  // the click surfaces a backend 4xx, which is a clearer signal than a
  // permanently-missing button.
  const canUseVision = billingPlan !== 'explorer'
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const frontendUrl = useLayoutStore(selectFrontendUrl)
  const backendUrl = useLayoutStore(selectBackendUrl)
  const projectKind = useLayoutStore(selectProjectKind)
  const previewMode = useLayoutStore(s => s.previewMode)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const previewSourcePath = useLayoutStore(s => s.previewSourcePath)
  const previewReloadKey = useLayoutStore(s => s.previewReloadKey)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const devServerLogs = useLayoutStore(s => s.devServerLogs)
  const isConsoleVisible = useLayoutStore(s => s.isConsoleVisible)
  const isHttpDrawerOpen = useLayoutStore(s => s.isHttpDrawerOpen)
  const previewServerTimedOut = useLayoutStore(s => s.previewServerTimedOut)
  const isPreviewServerLoading = useLayoutStore(s => s.isPreviewServerLoading)
  // PreviewView is sticky-mounted by MainLayout, so it keeps rendering even
  // when the user switches to Chat/Editor/Settings. While not the active view
  // we park the native macOS webview off-screen (via `frozen` below) —
  // otherwise the NSView keeps painting on top of whatever surface IS
  // active and the user sees a phantom webview sitting over their chat.
  const isPreviewActiveView = useLayoutStore(s => s.viewMode === 'preview')
  // Activation overlay — covers the iframe region for a short window after
  // the user switches BACK to Preview, while the native webview takes a
  // frame or two to reposition itself from its parked spot. Without this,
  // the user briefly sees the iframe Box's white background (or the right-
  // pane's dark background depending on layout) before the webview paints
  // over it, which previously came across as a "tudo escuro" flash on
  // every toggle. The overlay matches the iframe's white background so the
  // gap reads as a clean fade rather than a colour shift.
  const [showActivationOverlay, setShowActivationOverlay] = useState(false)
  const prevPreviewActiveRef = useRef(isPreviewActiveView)
  useEffect(() => {
    const wasActive = prevPreviewActiveRef.current
    prevPreviewActiveRef.current = isPreviewActiveView
    if (isPreviewActiveView && !wasActive) {
      setShowActivationOverlay(true)
      const timer = setTimeout(() => setShowActivationOverlay(false), 250)
      return () => clearTimeout(timer)
    }
  }, [isPreviewActiveView])

  // Main surface selection:
  //   - backend project → HttpClientPanel (no iframe)
  //   - frontend/fullstack → iframe preview
  //   - static → iframe with HTML content
  const showHttpClientMain = projectKind === 'backend'
  const showIframe = projectKind === 'frontend' || projectKind === 'fullstack' || previewMode === 'static'
  const isFullstack = projectKind === 'fullstack'
  const previewUrl = showHttpClientMain ? backendUrl : frontendUrl

  const [isChatCollapsed, setIsChatCollapsed] = useState(false)
  // True while the chat sidebar's width is animating (CSS transition 0.25s).
  // During that window the ResizeObserver on the iframe container fires every
  // animation frame, each one moves the macOS native wry webview a few pixels,
  // and the user sees a visible tremor as the NSView chases the DOM rect frame
  // by frame. Parking the webview off-screen while the animation runs and
  // restoring its position at the end produces a clean "snap to new size"
  // instead of frame-by-frame jitter.
  const [isChatAnimating, setIsChatAnimating] = useState(false)
  const chatSidebarRef = useRef<HTMLDivElement>(null)
  const toggleChatCollapsed = useCallback(() => {
    setIsChatAnimating(true)
    setIsChatCollapsed(v => !v)
  }, [])
  // React's `onTransitionEnd` fires per CSS property — width, min-width,
  // max-width and opacity all transition on the sidebar. We only care about
  // `width` (the one that drives the ResizeObserver and the webview rect
  // recalc), so we filter to that property and unfreeze precisely when the
  // browser confirms it's done. No fallback timer: the event is reliable
  // in practice and if it's ever dropped the worst case is the webview
  // stays parked until the next toggle (one extra click), which is better
  // than the timer prematurely unfreezing during a long animation.
  const handleSidebarTransitionEnd = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== 'width') return
    if (e.target !== chatSidebarRef.current) return
    setIsChatAnimating(false)
  }, [])

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const consoleHandleRef = useRef<HTMLDivElement>(null)
  const consoleScrollRef = useRef<HTMLDivElement>(null)

  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_WIDTH
  })
  const [consoleHeight, setConsoleHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(CONSOLE_STORAGE_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_CONSOLE_HEIGHT && parsed <= MAX_CONSOLE_HEIGHT) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_CONSOLE_HEIGHT
  })
  const [isResizing, setIsResizing] = useState(false)
  const [isResizingConsole, setIsResizingConsole] = useState(false)

  // Data Viewer drawer — local state (not in layoutStore) because it's
  // strictly a Preview-view affordance, unlike HTTP Client which is shared
  // with the standalone backend layout. Persisted via localStorage so the
  // user's "I want the data drawer open by default" preference survives reloads.
  const [isDataDrawerOpen, setIsDataDrawerOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DATA_DRAWER_OPEN_KEY) === '1'
    } catch { return false }
  })
  const [dataDrawerHeight, setDataDrawerHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(DATA_DRAWER_HEIGHT_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_DATA_DRAWER_HEIGHT && parsed <= MAX_DATA_DRAWER_HEIGHT) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_DATA_DRAWER_HEIGHT
  })
  const [isResizingDataDrawer, setIsResizingDataDrawer] = useState(false)
  const dataDrawerHandleRef = useRef<HTMLDivElement>(null)

  // Restore drawer-open state on mount (fullstack only).
  useEffect(() => {
    if (projectKind !== 'fullstack') return
    try {
      const saved = localStorage.getItem(HTTP_DRAWER_OPEN_KEY)
      if (saved === '1' && !useLayoutStore.getState().isHttpDrawerOpen) {
        useLayoutStore.getState().toggleHttpDrawer()
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKind])

  // Persist Data Viewer drawer open state.
  useEffect(() => {
    try {
      localStorage.setItem(DATA_DRAWER_OPEN_KEY, isDataDrawerOpen ? '1' : '0')
    } catch { /* ignore */ }
  }, [isDataDrawerOpen])

  // Persist drawer-open state whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(HTTP_DRAWER_OPEN_KEY, isHttpDrawerOpen ? '1' : '0')
    } catch { /* ignore */ }
  }, [isHttpDrawerOpen])

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  // Pagination — same shape used by ChatView / ChatPanel / TerminalView.
  // Render the last 30 messages; expand the window when the user scrolls
  // the chat sidebar toward the top. Reset on session switch so a new
  // conversation starts at the bottom.
  const { visibleItems: visibleChatItems, canLoadMore: chatCanLoadMore, loadMore: chatLoadMore, hiddenCount: chatHiddenCount } = useMessageWindow(messages, {
    resetKey: activeSessionId,
    pageSize: 2,
  })
  const chatLoadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const isChatLoadingMoreRef = useRef(false)
  useEffect(() => {
    if (!chatCanLoadMore) return
    const sentinel = chatLoadMoreSentinelRef.current
    const scrollEl = chatScrollRef.current
    if (!sentinel || !scrollEl) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        if (isChatLoadingMoreRef.current) return
        isChatLoadingMoreRef.current = true
        const beforeHeight = scrollEl.scrollHeight
        const beforeTop = scrollEl.scrollTop
        chatLoadMore()
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const delta = scrollEl.scrollHeight - beforeHeight
            if (delta > 0) scrollEl.scrollTop = beforeTop + delta
            setTimeout(() => { isChatLoadingMoreRef.current = false }, 200)
          })
        })
      },
      { root: scrollEl, rootMargin: '120px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // chatScrollRef is a stable useRef; reading .current inside the effect
    // doesn't need it in the dep array.
  }, [chatCanLoadMore, chatLoadMore])

  // Single pass over logs; memoized so subscribers that re-render the
  // wrapping component (e.g. on unrelated layoutStore changes) don't
  // re-scan the whole log list.
  const { errorCount, warnCount, hasErrors } = useMemo(() => {
    let e = 0, w = 0
    for (const l of devServerLogs) {
      if (l.level === 'error') e++
      else if (l.level === 'warn') w++
    }
    return { errorCount: e, warnCount: w, hasErrors: e > 0 }
  }, [devServerLogs])

  // Keyboard shortcut for fullstack drawer: Cmd/Ctrl + Shift + H
  useEffect(() => {
    if (projectKind !== 'fullstack') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        useLayoutStore.getState().toggleHttpDrawer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectKind])

  // Auto-scroll chat
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const rafId = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(rafId)
  }, [messages, messages.length])

  // Auto-scroll console
  useEffect(() => {
    const el = consoleScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [devServerLogs.length, isConsoleVisible])

  // Auto-reload when reloadKey changes (agent finished editing files)
  useEffect(() => {
    if (previewReloadKey === 0) return
    if (previewMode === 'static' && previewSourcePath) {
      StaticPreviewBuilder.getInstance()
        .buildPreview(previewSourcePath)
        .then(html => useLayoutStore.getState().setStaticPreview(html, previewSourcePath))
        .catch(() => {})
    }
    // Server mode: reloadKey is passed to TauriWebview which recreates the webview
  }, [previewReloadKey, previewMode, previewSourcePath])

  // Auto-open console when errors appear
  useEffect(() => {
    if (errorCount > 0 && !isConsoleVisible) {
      useLayoutStore.getState().toggleConsole()
    }
  }, [errorCount])

  const handleReload = useCallback(async () => {
    if (previewMode === 'static' && previewSourcePath) {
      try {
        const builder = StaticPreviewBuilder.getInstance()
        const html = await builder.buildPreview(previewSourcePath)
        useLayoutStore.getState().setStaticPreview(html, previewSourcePath)
      } catch {
        // Failed to rebuild
      }
    } else {
      // Trigger wry webview recreation via reloadKey
      useLayoutStore.getState().reloadPreview()
    }
  }, [previewMode, previewSourcePath])

  const handleOpenExternal = async () => {
    if (!previewUrl) return
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(previewUrl)
    } catch {
      window.open(previewUrl, '_blank')
    }
  }


  const handleStopServer = useCallback(async () => {
    closePreviewWebview()
    await devServerManager.stop()
    const layout = useLayoutStore.getState()
    layout.clearDevServer()
    const prev = layout.previousViewMode
    layout.setViewMode(prev && prev !== 'generating' && prev !== 'preview' ? prev : 'chat')
  }, [])

  // ── Preview screenshot → chat attachment ─────────────────────────────
  //
  // Same html2canvas approach as IssueReporterDialog (proven working in
  // production). Captures the DOM tree at the preview-container ref. Known
  // limitations inherited from that pattern:
  //   - Cross-origin iframe content paints as empty (the dev server is on
  //     localhost:PORT; the IDE on a Tauri custom protocol → cross-origin).
  //   - On macOS the native wry child webview lives outside the DOM, so
  //     html2canvas sees the empty wrapper Box. Still captures the
  //     surrounding chrome (toolbar, etc) within the preview area.
  // Trade-off accepted: matches the IDE's existing screenshot pattern,
  // zero native deps, works cross-platform without OS-level permissions.
  // For high-fidelity content capture (mac native webview / real iframe
  // pixels) a future native path can be added — out of scope for V1.
  const handleScreenshotToChat = useCallback(async () => {
    console.log('[screenshot] handler invoked', {
      canUseVision,
      isMac: IS_MAC,
      hasContainer: !!previewContainerRef.current,
      isCapturing,
    })
    if (!canUseVision) {
      console.warn('[screenshot] aborting — canUseVision=false (plan blocks vision)')
      useToastStore.getState().addToast(
        'warning',
        t('preview.screenshotPaidOnly'),
      )
      return
    }
    const container = previewContainerRef.current
    if (!container) {
      console.warn('[screenshot] previewContainerRef.current is null — aborting')
      useToastStore.getState().addToast(
        'error',
        'Preview area not ready. Reload the preview and try again.',
      )
      return
    }

    setIsCapturing(true)
    try {
      let blob: Blob | null = null

      if (IS_MAC) {
        // macOS native path. html2canvas can't capture the wry native
        // child webview (it lives outside the DOM tree), so on mac the
        // image came back all black. `screencapture` CLI reads the actual
        // framebuffer including the native webview's pixels.
        //
        // Coordinate sourcing: do NOT trust `window.screenX/Y`. The wry
        // webview on macOS reports those in the Cocoa AppKit coordinate
        // space (origin bottom-left of the primary display), which produced
        // a y value of ~2277 for a window that was actually near the top of
        // the screen → screencapture rejected with "rect does not intersect
        // any displays". `getCurrentWindow().outerPosition()` from Tauri
        // returns the window's top-left in **physical** pixels with origin
        // at the top-left of the primary display — the same frame
        // `screencapture -R` expects (after dividing by DPR to get points).
        const win = getCurrentWindow()
        const outer = await win.outerPosition()
        const scale = await win.scaleFactor()
        const windowTopLeftLogicalX = outer.x / scale
        const windowTopLeftLogicalY = outer.y / scale
        const rect = container.getBoundingClientRect()
        const x = Math.round(windowTopLeftLogicalX + rect.left)
        const y = Math.round(windowTopLeftLogicalY + rect.top)
        const w = Math.round(rect.width)
        const h = Math.round(rect.height)
        console.log('[screenshot] mac native capture invoking', {
          x, y, w, h,
          windowOuter: { x: outer.x, y: outer.y },
          scaleFactor: scale,
          windowTopLeftLogical: { x: windowTopLeftLogicalX, y: windowTopLeftLogicalY },
          rectLeft: rect.left,
          rectTop: rect.top,
          rectW: rect.width,
          rectH: rect.height,
        })
        const t0 = performance.now()
        const base64 = await invoke<string>('capture_screen_region_macos_native', {
          x, y, width: w, height: h,
        })
        const t1 = performance.now()
        console.log('[screenshot] invoke returned', {
          elapsedMs: Math.round(t1 - t0),
          base64Length: base64?.length ?? 0,
          base64Head: base64?.slice(0, 40),
        })
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        blob = new Blob([bytes], { type: 'image/png' })
        console.log('[screenshot] blob built', { size: blob.size, type: blob.type })
      } else {
        // Windows / Linux fallback — html2canvas. Iframe is in-DOM on
        // these platforms so the capture works partially (iframe element
        // bounds at minimum; content opaque if cross-origin). The Tauri
        // webview on Win/Linux is also a regular iframe under the hood
        // so this path covers both.
        const html2canvas = (await import('html2canvas')).default
        const canvas = await html2canvas(container, {
          backgroundColor: '#ffffff',
          scale: 1,
          logging: false,
          useCORS: true,
          allowTaint: true,
        })
        // Compress to JPEG ~0.8 quality, max-width 1280 — matches the
        // feedback-dialog defaults (kept image payload under ~400 KB).
        const MAX_W = 1280
        let outCanvas: HTMLCanvasElement = canvas
        if (canvas.width > MAX_W) {
          const ratio = MAX_W / canvas.width
          outCanvas = document.createElement('canvas')
          outCanvas.width = MAX_W
          outCanvas.height = Math.round(canvas.height * ratio)
          const ctx = outCanvas.getContext('2d')
          if (ctx) ctx.drawImage(canvas, 0, 0, outCanvas.width, outCanvas.height)
        }
        blob = await new Promise<Blob | null>(resolve =>
          outCanvas.toBlob(b => resolve(b), 'image/jpeg', 0.8),
        )
      }

      if (!blob) throw new Error('capture produced no image data')

      console.log('[screenshot] building attachment from blob', { size: blob.size, type: blob.type })
      const attachment = await createImageAttachmentFromClipboard(blob)
      const ext = blob.type === 'image/png' ? 'png' : 'jpg'
      attachment.name = `preview-screenshot-${Date.now()}.${ext}`
      console.log('[screenshot] calling addDraftAttachment', {
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        hasBase64: !!attachment.base64,
        base64Length: attachment.base64?.length ?? 0,
      })
      useChatStore.getState().addDraftAttachment(attachment)
      const draftAfter = useChatStore.getState().draftAttachments
      console.log('[screenshot] draft after attach', {
        count: draftAfter.length,
        last: draftAfter.length > 0 ? {
          id: draftAfter[draftAfter.length - 1].id,
          name: draftAfter[draftAfter.length - 1].name,
        } : null,
      })
      useToastStore.getState().addToast(
        'success',
        t('preview.screenshotAttached'),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[screenshot] capture failed:', err)
      // macOS Screen Recording permission denial — surface the actionable
      // hint. The Rust side returns a sentinel string when the captured
      // file is suspiciously small (a black image is the symptom of
      // declined permission); we also catch the generic "permission"
      // wording from any layer below.
      const isPermissionDenied =
        /screen recording|permission|denied|not permitted|unexpectedly small/i.test(msg)
      useToastStore.getState().addToast(
        'error',
        isPermissionDenied
          ? t('preview.screenshotPermissionDenied')
          : `${t('preview.screenshotFailed')}: ${msg}`,
        10_000,
      )
    } finally {
      setIsCapturing(false)
    }
  }, [canUseVision])

  // Horizontal resize (chat width)
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = handleRef.current
    if (!handleEl) return

    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }

    let current = chatWidth
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'
    setIsResizing(true)

    function onPointerMove(pe: PointerEvent) {
      let next = pe.clientX
      if (next < MIN_WIDTH) next = MIN_WIDTH
      if (next > MAX_WIDTH) next = MAX_WIDTH
      current = next
      setChatWidth(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(STORAGE_KEY, String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizing(false)
    }

    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [chatWidth])

  // Vertical resize (console height)
  const handleConsoleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = consoleHandleRef.current
    if (!handleEl) return

    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }

    const startY = e.clientY
    const startHeight = consoleHeight
    let current = consoleHeight
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'row-resize'
    body.style.userSelect = 'none'
    setIsResizingConsole(true)

    function onPointerMove(pe: PointerEvent) {
      // Dragging up = increasing height
      let next = startHeight + (startY - pe.clientY)
      if (next < MIN_CONSOLE_HEIGHT) next = MIN_CONSOLE_HEIGHT
      if (next > MAX_CONSOLE_HEIGHT) next = MAX_CONSOLE_HEIGHT
      current = next
      setConsoleHeight(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(CONSOLE_STORAGE_KEY, String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizingConsole(false)
    }

    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [consoleHeight])

  const hasPreview = !!(previewUrl || previewHtmlContent)

  const displayLabel = previewMode === 'static'
    ? (previewSourcePath?.split('/').pop() || 'Static Preview')
    : showHttpClientMain
      ? (previewUrl || 'HTTP Client')
      : (previewUrl || 'Loading...')

  // Data Viewer drawer resize (vertical, drag up from the top of the drawer)
  const handleDataDrawerResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = dataDrawerHandleRef.current
    if (!handleEl) return

    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }

    const startY = e.clientY
    const startH = dataDrawerHeight
    let current = dataDrawerHeight
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'row-resize'
    body.style.userSelect = 'none'
    setIsResizingDataDrawer(true)

    function onPointerMove(pe: PointerEvent) {
      let next = startH + (startY - pe.clientY)
      if (next < MIN_DATA_DRAWER_HEIGHT) next = MIN_DATA_DRAWER_HEIGHT
      if (next > MAX_DATA_DRAWER_HEIGHT) next = MAX_DATA_DRAWER_HEIGHT
      current = next
      setDataDrawerHeight(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(DATA_DRAWER_HEIGHT_KEY, String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizingDataDrawer(false)
    }

    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [dataDrawerHeight])

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left: Full chat sidebar (messages + prompt) — collapsible with animation */}
      <Flex
        ref={chatSidebarRef}
        direction="column"
        w={isChatCollapsed ? '0px' : `${chatWidth}px`}
        minW={isChatCollapsed ? '0px' : `${MIN_WIDTH}px`}
        maxW={isChatCollapsed ? '0px' : `${MAX_WIDTH}px`}
        overflow="hidden"
        bg={tokens.colors.bg.mainLayout}
        flexShrink={0}
        transition="width 0.25s ease, min-width 0.25s ease, max-width 0.25s ease"
        opacity={isChatCollapsed ? 0 : 1}
        css={{ transition: 'width 0.25s ease, min-width 0.25s ease, max-width 0.25s ease, opacity 0.2s ease' }}
        onTransitionEnd={handleSidebarTransitionEnd}
      >
        {/* Chat messages */}
        <Flex
          ref={chatScrollRef}
          direction="column"
          flex="1"
          overflowY="auto"
          py={3}
          px={3}
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: tokens.colors.border.panel,
              borderRadius: '2px',
            },
          }}
        >
          {messages.length === 0 ? (
            <Flex
              flex="1"
              direction="column"
              align="center"
              justify="center"
              gap={3}
            >
              <AgentLogo size={36} glow />
              <Flex direction="column" align="center" gap={1}>
                <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.muted} fontWeight={500}>
                  Ask the agent to iterate
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} textAlign="center" px={3} lineHeight="1.4">
                  Describe changes and see them live
                </Text>
              </Flex>
            </Flex>
          ) : (
            <Box maxW="600px" mx="auto" w="100%">
              {chatCanLoadMore && (
                <Box
                  as="button"
                  ref={chatLoadMoreSentinelRef}
                  w="100%"
                  textAlign="center"
                  fontSize={tokens.fontSize.xs}
                  fontWeight="500"
                  color={tokens.colors.text.muted}
                  py={2}
                  px={3}
                  mb={2}
                  borderRadius="6px"
                  bg={tokens.colors.bg.hoverSubtle}
                  border={`1px solid ${tokens.colors.border.panel}`}
                  cursor="pointer"
                  transition={`all ${tokens.transition.fast}`}
                  _hover={{
                    color: tokens.colors.text.primary,
                    borderColor: tokens.colors.border.glass,
                    bg: tokens.colors.bg.overlay,
                  }}
                  onClick={() => chatLoadMore()}
                >
                  ↑ Load earlier — {chatHiddenCount} hidden
                </Box>
              )}
              {visibleChatItems.map(msg => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={msg.id === streamingMessageId}
                />
              ))}
            </Box>
          )}
        </Flex>

        {/* Permission dialog above prompt */}
        {pendingPermission && (
          <PermissionDialog
            toolName={pendingPermission.toolName}
            args={pendingPermission.args}
            promptReason={pendingPermission.promptReason}
            onApprove={() => usePermissionStore.getState().approve()}
            onApproveAll={() => usePermissionStore.getState().approveAll()}
            onDeny={() => usePermissionStore.getState().deny()}
          />
        )}

        {/* PromptBar at bottom of chat sidebar */}
        <PromptBar />
      </Flex>

      {/* Resize handle (horizontal) — hidden when chat is collapsed */}
      <Box
        ref={handleRef}
        w={isChatCollapsed ? '0px' : '4px'}
        cursor="col-resize"
        flexShrink={0}
        bg={isResizing ? tokens.colors.accent.primary : 'transparent'}
        transition={isResizing ? 'none' : `all ${tokens.transition.fast}`}
        _hover={!isChatCollapsed ? { bg: tokens.colors.accent.primary } : {}}
        onPointerDown={isChatCollapsed ? undefined : handleResizeStart}
        position="relative"
        zIndex={2}
        overflow="hidden"
      />

      {/* Right: Preview webview + console */}
      <Flex
        direction="column"
        flex="1"
        overflow="hidden"
        bg={tokens.colors.bg.mainLayout}
      >
        {/* ── Browser-style toolbar ──────────────────────────────── */}
        <Flex
          align="center"
          gap={2}
          px={2}
          py={1.5}
          bg={tokens.colors.bg.panel}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
          flexShrink={0}
        >
          {/* Navigation + reload */}
          <HStack gap={0}>
            {previewMode !== 'api' && (
              <IconButton
                aria-label={t("view.reloadPreview")}
                size="xs"
                variant="ghost"
                color={tokens.colors.text.secondary}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                borderRadius="6px"
                onClick={handleReload}
              >
                <FiRefreshCw size={13} />
              </IconButton>
            )}
          </HStack>

          {/* Address bar */}
          <Flex
            flex={1}
            align="center"
            gap="6px"
            px={3}
            py="5px"
            bg={tokens.colors.bg.mainLayout}
            borderRadius="8px"
            border={`1px solid ${tokens.colors.border.panel}`}
            minW={0}
          >
            {previewMode === 'static' ? (
              <FiGlobe size={12} color={tokens.colors.text.disabled} style={{ flexShrink: 0 }} />
            ) : (
              <FiLock size={11} color={tokens.colors.accent.green} style={{ flexShrink: 0 }} />
            )}
            <Text
              fontSize="12px"
              color={tokens.colors.text.secondary}
              fontFamily={tokens.fontFamily.mono}
              lineClamp={1}
              flex={1}
              userSelect="all"
            >
              {showHttpClientMain ? 'HTTP Client' : displayLabel}
            </Text>
          </Flex>

          {/* Right actions */}
          <HStack gap={0}>
            {/* Expand/collapse chat sidebar */}
            <IconButton
              aria-label={isChatCollapsed ? 'Show chat' : 'Full preview'}
              size="xs"
              variant="ghost"
              color={isChatCollapsed ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={toggleChatCollapsed}
            >
              {isChatCollapsed ? <FiMinimize2 size={13} /> : <FiMaximize2 size={13} />}
            </IconButton>

            {/* HTTP Client drawer toggle — only visible for fullstack projects */}
            {isFullstack && (
              <IconButton
                aria-label={isHttpDrawerOpen ? 'Close HTTP Client' : 'Open HTTP Client'}
                size="xs"
                variant="ghost"
                color={isHttpDrawerOpen ? tokens.colors.accent.primary : tokens.colors.text.secondary}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                borderRadius="6px"
                onClick={() => useLayoutStore.getState().toggleHttpDrawer()}
                title="Toggle HTTP Client"
              >
                <FiZap size={13} />
              </IconButton>
            )}

            {/* Console */}
            <IconButton
              aria-label={t("view.toggleConsole")}
              size="xs"
              variant="ghost"
              color={isConsoleVisible ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={() => useLayoutStore.getState().toggleConsole()}
              position="relative"
            >
              <FiTerminal size={13} />
              {errorCount > 0 && (
                <Box position="absolute" top="1px" right="1px" w="6px" h="6px" borderRadius="full" bg="#f85149" />
              )}
              {errorCount === 0 && warnCount > 0 && (
                <Box position="absolute" top="1px" right="1px" w="6px" h="6px" borderRadius="full" bg="#e3b341" />
              )}
            </IconButton>

            {/* Open in system browser */}
            {/* Screenshot → chat (paid plans only). Lives in the toolbar
                rather than floating over the iframe because macOS uses a
                native wry child webview that paints ABOVE every DOM element
                — a floating button positioned over the webview area is
                literally invisible on macOS regardless of z-index. The
                toolbar sits above the webview rect, in pure DOM. Pink
                accent (brand color) so it reads as an action distinct from
                the surrounding ghost icons. */}
            {(() => {
              const shouldRender = canUseVision && hasPreview && showIframe
              // One-shot diagnostic: prints which gates pass/fail every render.
              // Cheap (3 booleans) and self-explanatory in DevTools.
              if (typeof window !== 'undefined') {
                ;(window as unknown as { __tmShotGates?: unknown }).__tmShotGates = {
                  canUseVision, hasPreview, showIframe, shouldRender,
                }
              }
              return shouldRender ? (
                <IconButton
                  aria-label={t('preview.screenshotToChat')}
                  title={t('preview.screenshotToChat')}
                  size="xs"
                  variant="ghost"
                  color={tokens.colors.accent.primary}
                  disabled={isCapturing}
                  _hover={{
                    bg: `${tokens.colors.accent.primary}22`,
                    color: tokens.colors.accent.primary,
                  }}
                  borderRadius="6px"
                  onPointerDown={() => console.log('[screenshot] pointerdown on button')}
                  onClick={(e) => {
                    console.log('[screenshot] click event fired', {
                      defaultPrevented: e.defaultPrevented,
                      isCapturing,
                    })
                    void handleScreenshotToChat()
                  }}
                >
                  <FiCamera size={13} />
                </IconButton>
              ) : null
            })()}

            {previewUrl && (
              <IconButton
                aria-label={t("view.openInBrowser")}
                size="xs"
                variant="ghost"
                color={tokens.colors.text.secondary}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                borderRadius="6px"
                onClick={handleOpenExternal}
              >
                <FiExternalLink size={13} />
              </IconButton>
            )}

            {/* Stop server */}
            {previewMode !== 'static' && previewUrl && (
              <IconButton
                aria-label={t("misc.stopServer")}
                size="xs"
                variant="ghost"
                color={tokens.colors.text.secondary}
                _hover={{ bg: 'rgba(248, 81, 73, 0.12)', color: '#f85149' }}
                borderRadius="6px"
                onClick={handleStopServer}
              >
                <FiSquare size={12} />
              </IconButton>
            )}

            {/* Data Viewer — toggles a bottom slide-up drawer rather than
                navigating to the standalone Data Viewer view, so the user
                inspects tables without losing the preview iframe. The full
                view is still reachable via Cmd/Ctrl+Shift+B or the chat-
                header button. */}
            <IconButton
              aria-label={t('dataViewer.title')}
              title={t('dataViewer.title')}
              size="xs"
              variant="ghost"
              color={isDataDrawerOpen ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={() => setIsDataDrawerOpen(v => !v)}
            >
              <FiDatabase size={13} />
            </IconButton>

            {/* Publish — opens the deploy modal. Free plan sees an upgrade
                CTA inside the modal rather than the deploy flow. */}
            <Button
              aria-label="Publish project"
              size="xs"
              variant="solid"
              bg={tokens.colors.accent.primary}
              color="white"
              _hover={{ bg: tokens.colors.accent.primaryDark, color: 'white' }}
              _active={{ bg: tokens.colors.accent.primaryDark }}
              borderRadius="6px"
              fontSize="11px"
              fontWeight="600"
              h="22px"
              px={2.5}
              gap={1}
              onClick={() => useLayoutStore.getState().setPublishModalOpen(true)}
              ml={1.5}
            >
              <FiUpload size={11} />
              Publish
            </Button>
          </HStack>
        </Flex>

        {/* ── Content area ──────────────────────────────────── */}
        {showHttpClientMain ? (
          // Backend-only project → HTTP Client occupies the full main area.
          <Flex flex="1" direction="column" overflow="hidden">
            <HttpClientPanel />
          </Flex>
        ) : (
          // Preview region — `position: relative` so the HTTP and Data
          // drawers can be `position: absolute` overlays on top of the iframe
          // instead of siblings in the column-flex layout. That earlier
          // setup made opening/closing a drawer reflow the iframe area:
          //   - HTTP drawer animating `flex: 1` from 0 → 1 yanked the
          //     iframe to display:none mid-transition, the drawer faded in,
          //     and on close the iframe popped back BEFORE the drawer
          //     finished fading out — the user saw a half-rendered drawer
          //     during the close.
          //   - Data drawer growing `height` pushed the iframe upward each
          //     frame, retriggering ResizeObserver → webview reposition →
          //     visible tremor.
          // Overlays make the iframe stationary; drawers fade in/out on top.
          // The native macOS wry webview still needs `frozen` to be parked
          // off-screen when the HTTP drawer is fully visible (NSView paints
          // above the DOM, no z-index trick fixes that), so the opacity
          // animation alone isn't enough there.
          <Box
            flex="1"
            bg={tokens.colors.text.inverse}
            position="relative"
            overflow="hidden"
          >
            {/* Activation overlay — same colour as the iframe Box, fades in
                instantly when the user re-activates Preview and fades out
                250 ms later. Covers the brief window during which the macOS
                native wry webview is moving from its parked spot to the
                real rect. Without it the user would see the iframe Box's
                background flash through before the webview paints over.
                Sits ABOVE the iframe Box but BELOW the drawers (z-index 5
                vs 10/11). Pointer-events none so it doesn't block clicks
                landing on the page once the webview has painted. */}
            {showActivationOverlay && (
              <Box
                position="absolute"
                inset={0}
                bg={tokens.colors.text.inverse}
                zIndex={5}
                pointerEvents="none"
                css={{
                  animation: 'activationOverlay 0.25s ease-out forwards',
                  '@keyframes activationOverlay': {
                    '0%': { opacity: 1 },
                    '70%': { opacity: 1 },
                    '100%': { opacity: 0 },
                  },
                }}
              />
            )}
            {hasPreview && showIframe ? (
              <Box ref={previewContainerRef} position="relative" w="100%" h="100%">
                <TauriWebview
                  url={previewMode === 'static' ? undefined : previewUrl!}
                  html={previewMode === 'static' ? previewHtmlContent! : undefined}
                  reloadKey={previewReloadKey}
                  // The macOS native wry webview is an NSView painted ABOVE
                  // the DOM — z-index can't keep an absolute-positioned
                  // overlay above it. Whenever a drawer overlay is open we
                  // park the webview off-screen so the overlay is actually
                  // visible. Trade-off: the Data drawer is a bottom slide,
                  // so freezing hides the still-visible top half of the
                  // preview. A future iteration could shrink the webview to
                  // (height - drawerHeight) instead of parking, preserving
                  // the upper iframe while the bottom shows the table viewer.
                  frozen={
                    !isPreviewActiveView
                    || isResizing
                    || isResizingConsole
                    || isChatAnimating
                    || (isFullstack && isHttpDrawerOpen)
                  }
                  // Data Viewer drawer takes the lower portion of the preview
                  // region — shrink the native webview by the drawer height
                  // instead of parking it off-screen. The user keeps seeing
                  // the upper part of the preview while inspecting tables
                  // below, which matches the original "preview + data
                  // simultaneously visible" intent the drawer was added for.
                  bottomReserveHeight={isDataDrawerOpen ? dataDrawerHeight + 4 : 0}
                />
                {(isResizing || isResizingConsole) && (
                  <Box
                    position="absolute"
                    inset={0}
                    bg="rgba(10, 10, 10, 0.6)"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    zIndex={5}
                    pointerEvents="none"
                  >
                    <Text fontSize="11px" color={tokens.colors.text.disabled} fontWeight="500">
                      Resizing...
                    </Text>
                  </Box>
                )}
              </Box>
            ) : (
              <Flex flex="1" align="center" justify="center" direction="column" gap={3}>
                {previewServerTimedOut ? (
                  <>
                    <Text fontSize={tokens.fontSize.sm} color={tokens.colors.accent.orange} fontWeight="500">
                      Server did not respond in time
                    </Text>
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} maxW="300px" textAlign="center">
                      The dev server may still be starting. Check the console for errors.
                    </Text>
                    <Box
                      as="button"
                      mt={1}
                      px={4}
                      py="6px"
                      borderRadius="6px"
                      fontSize="12px"
                      fontWeight="600"
                      bg={tokens.colors.accent.primary}
                      color="#fff"
                      cursor="pointer"
                      transition={`all ${tokens.transition.fast}`}
                      _hover={{ opacity: 0.85 }}
                      onClick={() => {
                        useLayoutStore.getState().setPreviewServerTimedOut(false)
                        useLayoutStore.getState().reloadPreview()
                      }}
                    >
                      Retry
                    </Box>
                  </>
                ) : hasErrors ? (
                  <>
                    <Text fontSize={tokens.fontSize.sm} color={tokens.colors.accent.red} fontWeight="500">
                      {t("view.devServerFailed")}
                    </Text>
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                      Check the console below for details
                    </Text>
                  </>
                ) : isPreviewServerLoading ? (
                  <>
                    <Box
                      w="20px" h="20px" borderRadius="full"
                      border="2px solid" borderColor={tokens.colors.border.panel}
                      borderTopColor={tokens.colors.accent.primary}
                      animation="spin 0.8s linear infinite"
                      css={{ '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }}
                    />
                    <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.disabled}>
                      Starting preview server...
                    </Text>
                  </>
                ) : (
                  <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.disabled}>
                    Waiting for preview server...
                  </Text>
                )}
              </Flex>
            )}

            {/* Data Viewer drawer — absolute overlay anchored to the bottom
                of the preview region. Doesn't push the iframe upward when
                opening/closing; the iframe stays still and the drawer
                animates its own height. Iframe remains visible behind /
                above the drawer area. */}
            <AnimatePresence>
              {isDataDrawerOpen && (
                <motion.div
                  key="data-drawer"
                  initial={{ y: '100%', opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: '100%', opacity: 0 }}
                  transition={isResizingDataDrawer
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 }
                  }
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: dataDrawerHeight + 4,
                    zIndex: 10,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
              <Box
                ref={dataDrawerHandleRef}
                h="4px"
                cursor="row-resize"
                flexShrink={0}
                bg={isResizingDataDrawer ? tokens.colors.accent.primary : 'transparent'}
                transition={isResizingDataDrawer ? 'none' : `background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.accent.primary }}
                onPointerDown={handleDataDrawerResizeStart}
                zIndex={2}
              />
              <Flex
                align="center"
                justify="space-between"
                px={3}
                py="6px"
                bg={tokens.colors.bg.panel}
                borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`}
                borderBottom={`1px solid ${tokens.colors.border.glass}`}
                flexShrink={0}
              >
                <HStack gap={2}>
                  <FiDatabase size={11} color={tokens.colors.accent.primary} />
                  <Text fontSize="11px" fontWeight={600} color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.5px">
                    {t('dataViewer.title')}
                  </Text>
                </HStack>
                <IconButton
                  aria-label="Close Data Viewer"
                  size="xs"
                  variant="ghost"
                  color={tokens.colors.text.disabled}
                  _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                  borderRadius="4px"
                  onClick={() => setIsDataDrawerOpen(false)}
                >
                  <FiChevronDown size={12} />
                </IconButton>
              </Flex>
              <Box flex="1" overflow="hidden" bg={tokens.colors.bg.mainLayout} display="flex" flexDirection="column">
                <DataViewerView embedded />
              </Box>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Fullstack HTTP Client — fullscreen overlay over the preview region
            (z-index above the data drawer so opening HTTP while data is open
            still wins). The iframe stays mounted behind. The macOS native
            wry webview is parked off-screen via `frozen={isHttpDrawerOpen}`
            because z-index can't move an NSView; without that the webview
            keeps painting on top. */}
        <AnimatePresence>
          {isFullstack && isHttpDrawerOpen && (
            <motion.div
              key="http-drawer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 11,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                background: tokens.colors.bg.mainLayout,
              }}
            >
              <Flex
                align="center"
                justify="space-between"
                px={3}
                py="6px"
                bg={tokens.colors.bg.panel}
                borderBottom={`1px solid ${tokens.colors.border.glass}`}
                flexShrink={0}
              >
                <HStack gap={2}>
                  <FiZap size={11} color={tokens.colors.accent.primary} />
                  <Text fontSize="11px" fontWeight={600} color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.5px">
                    HTTP Client
                  </Text>
                  {backendUrl && (
                    <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily="mono">
                      {backendUrl}
                    </Text>
                  )}
                </HStack>
                <IconButton
                  aria-label="Close HTTP Client"
                  size="xs"
                  variant="ghost"
                  color={tokens.colors.text.disabled}
                  _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                  borderRadius="4px"
                  onClick={() => useLayoutStore.getState().toggleHttpDrawer()}
                >
                  <FiChevronDown size={12} />
                </IconButton>
              </Flex>
              <Box flex="1" overflow="hidden" bg={tokens.colors.bg.mainLayout}>
                <HttpClientPanel />
              </Box>
            </motion.div>
          )}
        </AnimatePresence>
          </Box>
        )}

        {/* Console panel (DevTools-style) with slide animation */}
        <AnimatePresence>
          {isConsoleVisible && (
            <motion.div
              key="console-panel"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: consoleHeight + 4, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={isResizingConsole
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 }
              }
              style={{ flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            >
              {/* Resize handle (vertical) */}
              <Box
                ref={consoleHandleRef}
                h="4px"
                cursor="row-resize"
                flexShrink={0}
                bg={isResizingConsole ? tokens.colors.accent.primary : 'transparent'}
                transition={isResizingConsole ? 'none' : `background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.accent.primary }}
                onPointerDown={handleConsoleResizeStart}
                zIndex={2}
              />

              {/* Console content */}
              <Flex
                direction="column"
                flex="1"
                bg="#0d0d0d"
                borderTop={`1px solid ${tokens.colors.border.panel}`}
                overflow="hidden"
              >
                {/* Console header */}
                <Flex
                  align="center"
                  justify="space-between"
                  px={3}
                  py={1.5}
                  flexShrink={0}
                  borderBottom={`1px solid ${tokens.colors.border.panel}`}
                >
                  <HStack gap={3}>
                    <Text fontSize="11px" fontWeight={600} color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.5px">
                      Console
                    </Text>
                    {errorCount > 0 && (
                      <HStack gap={1}>
                        <Box w="6px" h="6px" borderRadius="full" bg="#f85149" />
                        <Text fontSize="11px" color="#f85149">{errorCount}</Text>
                      </HStack>
                    )}
                    {warnCount > 0 && (
                      <HStack gap={1}>
                        <Box w="6px" h="6px" borderRadius="full" bg="#e3b341" />
                        <Text fontSize="11px" color="#e3b341">{warnCount}</Text>
                      </HStack>
                    )}
                  </HStack>
                  <HStack gap={0}>
                    <IconButton
                      aria-label={t("misc.clearConsole")}
                      size="xs"
                      variant="ghost"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                      borderRadius="4px"
                      onClick={() => useLayoutStore.getState().clearDevServerLogs()}
                    >
                      <FiTrash2 size={12} />
                    </IconButton>
                    <IconButton
                      aria-label={t("misc.closeConsole")}
                      size="xs"
                      variant="ghost"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                      borderRadius="4px"
                      onClick={() => useLayoutStore.getState().toggleConsole()}
                    >
                      <FiChevronDown size={12} />
                    </IconButton>
                  </HStack>
                </Flex>

                {/* Console log entries */}
                <Box
                  ref={consoleScrollRef}
                  flex="1"
                  overflowY="auto"
                  px={3}
                  py={1}
                  css={{
                    '&::-webkit-scrollbar': { width: '4px' },
                    '&::-webkit-scrollbar-track': { background: 'transparent' },
                    '&::-webkit-scrollbar-thumb': {
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: '2px',
                    },
                  }}
                >
                  {devServerLogs.length === 0 ? (
                    <Text fontSize="11px" color={tokens.colors.text.disabled} py={2}>
                      {t("view.noOutputYet")}
                    </Text>
                  ) : (
                    devServerLogs.map((entry: DevServerLogEntry) => (
                      <ConsoleLogLine key={entry.id} entry={entry} />
                    ))
                  )}
                </Box>
              </Flex>
            </motion.div>
          )}
        </AnimatePresence>
      </Flex>
    </Flex>
  )
}

function sendLogToAgent(entry: DevServerLogEntry): void {
  // Wrap the captured output in a fenced code block so the agent can tell
  // it apart from the framing question, and prefix the level so error/warn
  // context isn't lost. entry.text may be MULTI-LINE — the dev-server log
  // pipeline coalesces console.log({obj}) dumps and stack traces into one
  // entry so the agent receives the whole block, not just one fragment.
  // Queue priority 'next' matches the prompt bar — dispatches immediately
  // when the agent is idle, otherwise queues behind the in-flight turn.
  const time = new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false })
  const levelLabel = entry.level === 'error' ? 'ERROR' : entry.level === 'warn' ? 'WARN' : 'INFO'
  const header = `[${levelLabel}] ${time}`
  const isMultiline = entry.text.includes('\n')
  const body = isMultiline ? `${header}\n${entry.text}` : `${header}  ${entry.text}`
  const prompt = `Help me with this dev server console output:\n\n\`\`\`\n${body}\n\`\`\``
  enqueueMessage({
    value: prompt,
    mode: 'prompt',
    priority: 'next',
    uuid: generateId('queued'),
  })
  useLayoutStore.getState().setViewMode('chat')
}

const ConsoleLogLine = memo(function ConsoleLogLine({ entry }: { entry: DevServerLogEntry }) {
  const color = LOG_COLORS[entry.level] || tokens.colors.text.secondary
  const bgColor = entry.level === 'error'
    ? 'rgba(248, 81, 73, 0.06)'
    : entry.level === 'warn'
      ? 'rgba(227, 179, 65, 0.06)'
      : 'transparent'

  return (
    <Flex
      className="group"
      align="flex-start"
      gap={2}
      py="2px"
      px={1}
      borderBottom="1px solid rgba(255,255,255,0.03)"
      bg={bgColor}
      borderRadius="2px"
    >
      <Text
        fontSize="10px"
        color={tokens.colors.text.disabled}
        fontFamily="mono"
        flexShrink={0}
        mt="1px"
        userSelect="none"
      >
        {new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
      </Text>
      <Text
        flex={1}
        fontSize="11px"
        color={color}
        fontFamily="mono"
        whiteSpace="pre-wrap"
        wordBreak="break-all"
        lineHeight="1.5"
      >
        {entry.text}
      </Text>
      <IconButton
        aria-label={t('misc.sendToAgent')}
        title={t('misc.sendToAgent')}
        size="2xs"
        variant="ghost"
        flexShrink={0}
        opacity={0}
        color={tokens.colors.text.muted}
        transition={tokens.transition.fast}
        _groupHover={{ opacity: 1 }}
        _hover={{
          color: tokens.colors.accent.primary,
          bg: 'rgba(254, 16, 99, 0.1)',
        }}
        onClick={() => sendLogToAgent(entry)}
      >
        <FiSend size={10} />
      </IconButton>
    </Flex>
  )
})

export default memo(PreviewView)
