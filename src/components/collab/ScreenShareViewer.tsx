import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { VscClose, VscMultipleWindows, VscScreenFull } from 'react-icons/vsc'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { useCollabStore } from '@/stores/collabStore'
import { useToastStore } from '@/stores/toastStore'
import { stopWatching } from '@/services/collab/collabScreen'
import { ElapsedLabel } from './ElapsedLabel'
import { PeerPathBadge } from './PeerPathBadge'

/** The webkit presentation-mode surface WKWebView exposes on <video> (macOS)
 *  — the standard requestPictureInPicture path is Chromium/WebView2. */
type PipVideoElement = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitPresentationMode?: string
}

/**
 * Floating viewer for a teammate's screen share. Mounted once in MainLayout
 * (next to TeamChatPanel), visible while WE opted in to watch. The stream is
 * pure video — narration travels on the voice call — so the element is muted,
 * which also makes autoplay unconditionally allowed.
 *
 * Draggable by the header, resizable by the bottom-right corner; the rect
 * persists across sessions (localStorage) and is clamped back into the
 * viewport on mount so a disconnected monitor can't strand it off-screen.
 */

const RECT_STORAGE_KEY = 'tm.screenviewer.rect'
const MIN_W = 320
const MIN_H = 220
const HEADER_H = 32
const VIEWPORT_MARGIN = 24

interface ViewerRect {
  x: number
  y: number
  w: number
  h: number
}

function defaultRect(): ViewerRect {
  const w = 640
  const h = Math.round(((w * 9) / 16) + HEADER_H)
  return {
    x: Math.max(VIEWPORT_MARGIN, window.innerWidth - w - 348),
    y: Math.max(VIEWPORT_MARGIN, window.innerHeight - h - 48),
    w,
    h,
  }
}

function clampRect(r: ViewerRect): ViewerRect {
  const w = Math.min(Math.max(r.w, MIN_W), window.innerWidth - VIEWPORT_MARGIN)
  const h = Math.min(Math.max(r.h, MIN_H), window.innerHeight - VIEWPORT_MARGIN)
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, VIEWPORT_MARGIN - w + 80), window.innerWidth - 80),
    y: Math.min(Math.max(r.y, 0), window.innerHeight - HEADER_H - 8),
  }
}

function loadRect(): ViewerRect {
  try {
    const raw = localStorage.getItem(RECT_STORAGE_KEY)
    if (!raw) return defaultRect()
    const parsed = JSON.parse(raw) as Partial<ViewerRect>
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.w !== 'number' ||
      typeof parsed.h !== 'number'
    ) {
      return defaultRect()
    }
    return clampRect(parsed as ViewerRect)
  } catch {
    return defaultRect()
  }
}

export function ScreenShareViewer() {
  const t = useTranslation()
  const watching = useCollabStore((s) => s.screenWatching)
  const presenter = useCollabStore((s) => s.screenPresenter)
  const stream = useCollabStore((s) => s.screenRemoteStream)
  const presenterSince = useCollabStore((s) => s.screenPresenterSince)
  // The presenter is known by uid; the connection path by mesh peerId.
  const presenterPath = useCollabStore((s) => {
    const peerId = s.peers.find((p) => p.uid === s.screenPresenter?.uid)?.peerId
    return peerId ? s.peerPaths[peerId] : undefined
  })
  const videoRef = useRef<HTMLVideoElement>(null)
  const [rect, setRect] = useState<ViewerRect>(() => loadRect())
  const rectRef = useRef(rect)
  rectRef.current = rect

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => {/* retried implicitly by autoPlay */})
  }, [stream, watching])

  // ── "Fora da IDE" — Picture-in-Picture (system floating window) ──────────
  // The <video> stays mounted while PiP is active (removing it would close
  // the system window); the in-app panel just turns invisible + click-through.
  const [pip, setPip] = useState(false)

  useEffect(() => {
    const el = videoRef.current as PipVideoElement | null
    if (!el) return
    const onEnter = () => setPip(true)
    const onLeave = () => setPip(false)
    // WKWebView signals mode changes through a single webkit event.
    const onModeChange = () => {
      if (typeof el.webkitPresentationMode === 'string') {
        setPip(el.webkitPresentationMode === 'picture-in-picture')
      }
    }
    el.addEventListener('enterpictureinpicture', onEnter)
    el.addEventListener('leavepictureinpicture', onLeave)
    el.addEventListener('webkitpresentationmodechanged', onModeChange)
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter)
      el.removeEventListener('leavepictureinpicture', onLeave)
      el.removeEventListener('webkitpresentationmodechanged', onModeChange)
    }
  }, [watching])

  const enterPip = useCallback(async () => {
    const el = videoRef.current as PipVideoElement | null
    if (!el) return
    try {
      // Chromium (WebView2 / Windows) — the standard API.
      if (typeof el.requestPictureInPicture === 'function') {
        await el.requestPictureInPicture()
        return
      }
      // WKWebView (macOS) — webkit presentation mode.
      if (el.webkitSupportsPresentationMode?.('picture-in-picture')) {
        el.webkitSetPresentationMode?.('picture-in-picture')
        return
      }
      useToastStore.getState().addToast('warning', t('team.screenPipUnsupported'))
    } catch {
      useToastStore.getState().addToast('warning', t('team.screenPipUnsupported'))
    }
  }, [t])

  const exitPip = useCallback(() => {
    const el = videoRef.current as PipVideoElement | null
    void (document as Document & { exitPictureInPicture?: () => Promise<void> })
      .exitPictureInPicture?.()
      .catch(() => {})
    el?.webkitSetPresentationMode?.('inline')
  }, [])

  const persist = useCallback((r: ViewerRect) => {
    try {
      localStorage.setItem(RECT_STORAGE_KEY, JSON.stringify(r))
    } catch {
      /* storage full/unavailable — position just won't persist */
    }
  }, [])

  /** Shared pointer-drag driver for both the move and resize gestures. */
  const beginGesture = useCallback(
    (e: React.PointerEvent, apply: (dx: number, dy: number, start: ViewerRect) => ViewerRect) => {
      e.preventDefault()
      const target = e.currentTarget as HTMLElement
      try {
        target.setPointerCapture(e.pointerId)
      } catch {
        /* capture unsupported — plain move events still work */
      }
      const startX = e.clientX
      const startY = e.clientY
      const start = rectRef.current
      const onMove = (pe: PointerEvent) => {
        setRect(clampRect(apply(pe.clientX - startX, pe.clientY - startY, start)))
      }
      const onUp = () => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
        persist(rectRef.current)
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      // Cancelled gestures (OS gestures, capture loss) must not leak listeners.
      target.addEventListener('pointercancel', onUp)
    },
    [persist],
  )

  if (!watching || !presenter) return null

  return (
    <>
    <Box
      position="fixed"
      left={`${rect.x}px`}
      top={`${rect.y}px`}
      w={`${rect.w}px`}
      h={`${rect.h}px`}
      zIndex={49}
      display="flex"
      flexDirection="column"
      bg={tokens.colors.bg.overlay}
      border={`1px solid ${tokens.colors.border.default}`}
      borderRadius="8px"
      boxShadow="0 12px 40px rgba(0,0,0,0.45)"
      overflow="hidden"
      // While the video lives in the system PiP window the in-app panel goes
      // invisible + click-through — but stays MOUNTED: unmounting the <video>
      // would close the floating window.
      visibility={pip ? 'hidden' : 'visible'}
      pointerEvents={pip ? 'none' : 'auto'}
    >
      {/* Header — drag handle */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h={`${HEADER_H}px`}
        flexShrink={0}
        bg={tokens.colors.bg.glass}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
        cursor="grab"
        _active={{ cursor: 'grabbing' }}
        style={{ touchAction: 'none', userSelect: 'none' }}
        onPointerDown={(e) => {
          // Buttons keep their clicks; everything else starts the drag.
          if ((e.target as HTMLElement).closest('button')) return
          beginGesture(e, (dx, dy, start) => ({ ...start, x: start.x + dx, y: start.y + dy }))
        }}
      >
        <Flex align="center" gap={2} minW={0}>
          <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.red} flexShrink={0} />
          <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1}>
            {t('team.screenPresenting').replace('{name}', presenter.name)}
          </Text>
          <PeerPathBadge path={presenterPath} size={12} />
          <ElapsedLabel
            since={presenterSince}
            fontSize="10px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.muted}
            flexShrink={0}
          />
        </Flex>
        <Flex align="center" gap={2} flexShrink={0}>
          <Box
            as="button"
            aria-label={t('team.screenPopOut')}
            title={t('team.screenPopOut')}
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => void enterPip()}
          >
            <VscMultipleWindows size={14} />
          </Box>
          <Box
            as="button"
            aria-label={t('team.screenFullscreen')}
            title={t('team.screenFullscreen')}
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => void videoRef.current?.requestFullscreen().catch(() => {})}
          >
            <VscScreenFull size={14} />
          </Box>
          <Box
            as="button"
            aria-label={t('team.screenStopWatch')}
            title={t('team.screenStopWatch')}
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => stopWatching()}
          >
            <VscClose size={15} />
          </Box>
        </Flex>
      </Flex>

      <Box position="relative" flex={1} minH={0} bg="#000">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
        {!stream && (
          <Flex position="absolute" inset={0} align="center" justify="center">
            <Text fontSize="11px" color={tokens.colors.text.muted}>
              {t('team.screenWaiting')}
            </Text>
          </Flex>
        )}
        {/* Resize handle — bottom-right corner */}
        <Box
          position="absolute"
          right={0}
          bottom={0}
          w="16px"
          h="16px"
          cursor="nwse-resize"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) =>
            beginGesture(e, (dx, dy, start) => ({ ...start, w: start.w + dx, h: start.h + dy }))
          }
        >
          <Box
            position="absolute"
            right="3px"
            bottom="3px"
            w="8px"
            h="8px"
            borderRight={`2px solid ${tokens.colors.text.muted}`}
            borderBottom={`2px solid ${tokens.colors.text.muted}`}
            opacity={0.7}
            borderBottomRightRadius="3px"
          />
        </Box>
      </Box>
    </Box>

    {/* Compact pill while the presentation lives in the system PiP window */}
    {pip && (
      <Flex
        position="fixed"
        bottom="16px"
        right="16px"
        zIndex={49}
        align="center"
        gap={2}
        px={3}
        py={2}
        bg={tokens.colors.bg.overlay}
        border={`1px solid ${tokens.colors.border.default}`}
        borderRadius="8px"
        boxShadow="0 12px 40px rgba(0,0,0,0.45)"
      >
        <VscMultipleWindows size={13} color={tokens.colors.text.muted} />
        <Text fontSize="11px" color={tokens.colors.text.secondary}>
          {t('team.screenPipActive')}
        </Text>
        <Box
          as="button"
          fontSize="10px"
          fontWeight="600"
          px="8px"
          py="3px"
          borderRadius="5px"
          color={tokens.colors.badge.notificationText}
          bg={tokens.colors.accent.primary}
          onClick={exitPip}
        >
          {t('team.screenPipRestore')}
        </Box>
        <Box
          as="button"
          aria-label={t('team.screenStopWatch')}
          title={t('team.screenStopWatch')}
          color={tokens.colors.text.muted}
          _hover={{ color: tokens.colors.text.primary }}
          onClick={() => stopWatching()}
        >
          <VscClose size={14} />
        </Box>
      </Flex>
    )}
    </>
  )
}
