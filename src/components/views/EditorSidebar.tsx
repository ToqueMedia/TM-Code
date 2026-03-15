import { memo, useRef, useState, useEffect, useCallback } from 'react'
import { Box } from '@chakra-ui/react'
import ExplorerPanel from '../ui/ExplorerPanel'
import { tokens } from '@/theme/tokens'

const STORAGE_KEY_EXPLORER_WIDTH = 'panel-size-explorer-panel'

interface EditorSidebarProps {
  onFileSelect: (path: string) => void
}

function EditorSidebar({ onFileSelect }: EditorSidebarProps) {
  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_EXPLORER_WIDTH)
      const screen = window.innerWidth
      const min = 40
      const max = Math.max(100, screen - 360)
      const def = Math.min(250, Math.max(Math.floor(screen * 0.2), min))
      return saved ? Math.min(Math.max(parseInt(saved, 10), min), max) : def
    } catch { return 250 }
  })

  const sidebarRef = useRef<HTMLDivElement>(null)
  const sidebarHandleRef = useRef<HTMLDivElement>(null)
  const [, setIsResizingExplorer] = useState(false)

  useEffect(() => {
    function handleResize() {
      const min = 40
      const max = Math.max(100, window.innerWidth - 360)
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
    setIsResizingExplorer(true)

    function onPointerMove(pe: PointerEvent) {
      const min = 40
      const max = Math.max(100, window.innerWidth - 360)
      let next = pe.clientX - sidebarLeft
      if (next < min) next = min
      if (next > max) next = max
      current = next
      setExplorerWidth(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(STORAGE_KEY_EXPLORER_WIDTH, String(current)) } catch {}
      try { handleEl?.releasePointerCapture(pid) } catch {}
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizingExplorer(false)
    }

    handleEl?.addEventListener('pointermove', onPointerMove)
    handleEl?.addEventListener('pointerup', onPointerUp)
  }, [explorerWidth])

  return (
    <Box
      width={`${explorerWidth}px`}
      bg={tokens.colors.bg.mainLayout}
      height="100%"
      position="relative"
      borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
      ref={sidebarRef}
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
