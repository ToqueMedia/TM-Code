import { memo, useRef, useState, useEffect, useCallback } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const STORAGE_KEY_SIDEBAR_WIDTH = 'panel-size-sidebar'
const CLOSE_THRESHOLD = 80

interface EditorSidebarProps {
  children: React.ReactNode
  onClose?: () => void
}

function EditorSidebar({ children, onClose }: EditorSidebarProps) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SIDEBAR_WIDTH)
      const screen = window.innerWidth
      const min = 120
      const max = Math.max(200, screen - 360)
      const def = Math.min(250, Math.max(Math.floor(screen * 0.2), min))
      return saved ? Math.min(Math.max(parseInt(saved, 10), min), max) : def
    } catch { return 250 }
  })

  const sidebarRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const isDraggingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Cleanup drag on unmount
  useEffect(() => {
    return () => { cleanupRef.current?.() }
  }, [])

  // Clamp width on window resize
  useEffect(() => {
    function handleResize() {
      if (isDraggingRef.current) return
      const min = 120
      const max = Math.max(200, window.innerWidth - 360)
      setWidth(prev => Math.min(Math.max(prev, min), max))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = handleRef.current
    const sidebar = sidebarRef.current
    if (!handleEl || !sidebar) return

    const sidebarLeft = sidebar.getBoundingClientRect().left
    let current = sidebar.offsetWidth
    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch {}
    isDraggingRef.current = true

    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'

    // Remove CSS transition during drag for instant response
    sidebar.style.transition = 'none'

    function cleanup() {
      isDraggingRef.current = false
      try { handleEl?.releasePointerCapture(pid) } catch {}
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      if (sidebar) sidebar.style.transition = ''
      cleanupRef.current = null
    }

    function onPointerMove(pe: PointerEvent) {
      const max = Math.max(200, window.innerWidth - 360)
      let next = pe.clientX - sidebarLeft
      if (next > max) next = max
      current = next

      // Close immediately when dragged below threshold
      if (next < CLOSE_THRESHOLD && onCloseRef.current) {
        cleanup()
        onCloseRef.current()
        return
      }

      // Direct DOM update — no React re-render
      const clamped = Math.max(next, 120)
      if (sidebar) sidebar.style.width = `${clamped}px`
    }

    function onPointerUp() {
      cleanup()
      // Commit final width to React state (single re-render)
      const clamped = Math.max(current, 120)
      setWidth(clamped)
      try { localStorage.setItem(STORAGE_KEY_SIDEBAR_WIDTH, String(clamped)) } catch {}
    }

    cleanupRef.current = cleanup
    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [])

  return (
    <Box
      width={`${width}px`}
      bg={tokens.colors.bg.mainLayout}
      height="100%"
      position="relative"
      borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
      ref={sidebarRef}
      transition="width 0.05s ease"
      flexShrink={0}
      overflow="hidden"
      display="flex"
      flexDirection="column"
    >
      {children}
      {/* Resize handle */}
      <Box
        position="absolute"
        right="0"
        top="0"
        bottom="0"
        width="6px"
        cursor="col-resize"
        bg="transparent"
        _hover={{ bg: tokens.colors.accent.primaryGlow }}
        onPointerDown={handleResizeStart}
        zIndex={10}
        ref={handleRef}
        style={{ touchAction: 'none' }}
      />
    </Box>
  )
}

export default memo(EditorSidebar)
