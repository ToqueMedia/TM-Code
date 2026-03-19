import { memo, useRef, useState, useEffect, useCallback } from 'react'
import { Box } from '@chakra-ui/react'
import ExplorerPanel from '../ui/ExplorerPanel'
import { tokens } from '@/theme/tokens'

const STORAGE_KEY_EXPLORER_WIDTH = 'panel-size-explorer-panel'
const CLOSE_THRESHOLD = 80

interface EditorSidebarProps {
  onFileSelect: (path: string) => void
  onClose?: () => void
}

function EditorSidebar({ onFileSelect, onClose }: EditorSidebarProps) {
  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_EXPLORER_WIDTH)
      const screen = window.innerWidth
      const min = 120
      const max = Math.max(200, screen - 360)
      const def = Math.min(250, Math.max(Math.floor(screen * 0.2), min))
      return saved ? Math.min(Math.max(parseInt(saved, 10), min), max) : def
    } catch { return 250 }
  })

  const sidebarRef = useRef<HTMLDivElement>(null)
  const sidebarHandleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleResize() {
      const min = 120
      const max = Math.max(200, window.innerWidth - 360)
      setExplorerWidth(prev => Math.min(Math.max(prev, min), max))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleExplorerResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = sidebarHandleRef.current
    const sidebarLeft = sidebarRef.current ? sidebarRef.current.getBoundingClientRect().left : 0
    let current = explorerWidth
    const pid = e.pointerId
    try { handleEl?.setPointerCapture(pid) } catch {}

    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'

    function cleanup() {
      try { handleEl?.releasePointerCapture(pid) } catch {}
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
    }

    function onPointerMove(pe: PointerEvent) {
      const max = Math.max(200, window.innerWidth - 360)
      let next = pe.clientX - sidebarLeft
      if (next > max) next = max
      current = next

      // Close immediately when dragged below threshold
      if (next < CLOSE_THRESHOLD && onClose) {
        cleanup()
        onClose()
        return
      }

      setExplorerWidth(Math.max(next, 120))
    }

    function onPointerUp() {
      cleanup()
      const clamped = Math.max(current, 120)
      setExplorerWidth(clamped)
      try { localStorage.setItem(STORAGE_KEY_EXPLORER_WIDTH, String(clamped)) } catch {}
    }

    handleEl?.addEventListener('pointermove', onPointerMove)
    handleEl?.addEventListener('pointerup', onPointerUp)
  }, [explorerWidth, onClose])

  return (
    <Box
      width={`${explorerWidth}px`}
      bg={tokens.colors.bg.mainLayout}
      height="100%"
      position="relative"
      borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
      ref={sidebarRef}
      transition="width 0.05s ease"
    >
      <ExplorerPanel onFileSelect={onFileSelect} />
      <Box
        position="absolute"
        right="0"
        top="0"
        bottom="0"
        width="6px"
        cursor="col-resize"
        bg="transparent"
        _hover={{ bg: tokens.colors.accent.primaryGlow }}
        onPointerDown={handleExplorerResizeStart}
        zIndex={10}
        ref={sidebarHandleRef}
        style={{ touchAction: 'none' }}
      />
    </Box>
  )
}

export default memo(EditorSidebar)
